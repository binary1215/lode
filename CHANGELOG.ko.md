# 변경 기록

[English](CHANGELOG.md)

## 게시 정책

중간 베타는 CI와 게시 검증이 성공한 뒤 Codex·Claude 마켓플레이스 브랜치로
배포합니다. 소스 커밋이나 버전 번호만으로 게시 성공을 뜻하지 않습니다. Git 태그와
GitHub Release는 별도로 지정한 릴리스에만 만들며 과거 중간 태그를 소급 생성하지
않습니다. 마켓플레이스 게시가 로컬 설치나 Host/MCP 재로드를 입증하지는 않습니다.

## 0.3.0-beta.120 — 게시 결과는 별도 확인

- 게시되는 작업 문서(Obsidian 볼트, Notion)를 읽는 사람에게 맞춰 배치합니다.
  - 문서는 `Lode/<제품>/<기능군>/<기능>/` 트리에 놓이고, 기능 폴더 안에 결과마다
    새 파일이 생깁니다. 폴더와 파일 이름은 해시가 아니라 읽을 수 있는 제목입니다.
    제품·기능군·기능 폴더 문서가 목록을 담으며, 작업별 시작 문서와 메모 문서는
    만들지 않습니다.
  - 사람용 문서에는 관리용 줄(identity 줄, 표식, basis 해시, 내부 id)이 없습니다.
    이 정보는 에이전트가 열어 볼 수 있는 별도의 근거 문서에 있고, 사람용 문서는
    그 문서로 링크합니다.
  - `lode_work_document_prepare`가 `feature_keys`를 받습니다. 사용자가 지정한
    기능이 우선이고, 없으면 에이전트가 Product model의 기능 중에서 고릅니다.
    알려진 기능이 없는 결과는 `소속 미확인/`에 놓이고 거절된 key를 보고합니다.
  - 이전 배치로 게시된 문서는 다시 쓰거나 옮기지 않습니다. 이전 시작 문서에 새
    트리로 가는 링크 하나만 추가합니다. Product model에서 기능 이름을 바꾸거나
    옮겨도 기존 폴더는 옮기지 않습니다.
  - 사람이 고친 문서는 덮어쓰지 않습니다. 그 안의 Lode 목록만 갱신하고 수정
    사실을 보고합니다. Lode가 쓴 내용과 정확히 같게 되돌린 문서는 다시 Lode
    문서로 다룹니다.
- 실패한 쓰기 하나가 이후 게시를 멈추지 않습니다.
  - Obsidian 파일: 결과를 모르는 생성·갱신은 파일을 보고 판정합니다. 파일이
    없거나 이전 내용이면 다시 쓰고, Lode가 쓴 내용이면 받아들이고, 그 밖의
    내용이면 사람의 파일이나 수정으로 보고 그대로 둡니다. 볼트 파일에 한해
    "다시 쓰지 않는다"는 규칙을 대체합니다.
  - Notion은 확인되지 않은 같은 변경을 다시 보내지 않는 규칙을 유지합니다.
    결과를 모르는 페이지 갱신은 이제 그 문서만 붙잡아 `update-unconfirmed`로
    보고하고 나머지 게시는 계속합니다. 그 문서에 다른 내용이 필요한 다음 게시가
    현재 페이지 내용에서 만든 새 변경을 보냅니다.
  - 한계: 원하는 내용이 다시 바뀌지 않는 Notion 문서는 `update-unconfirmed`로
    남아 게시할 때마다 보고됩니다. 결과를 확인할 수 없는 Notion 생성은 복구
    한계와 함께 보고되며 아직 벗어날 방법이 없습니다. Notion 동작은 합성 서버로만
    검사했고 실제 서비스로는 확인하지 않았습니다.

## 0.3.0-beta.119 — 게시 결과는 별도 확인

- 관리 파일이 기록된 바이트와 줄 끝만 다른 경우(예: checkout이 LF를 CRLF로 바꾼
  경우) 명시적 resume이 원래 바이트로 복구합니다. 폴더를 옮긴 Project도 같습니다.
  이전에는 이런 Project가 drift로 읽혔고, 옮긴 Project는 relocation할 수
  없었습니다.
  - 읽기 전용 status가 다음 단계를 알려 줍니다. 옮기지 않은 Project는
    `core_drifted`와 `byteRepair`, 다음 단계 `resume_line_ending_repair`를,
    옮긴 Project는 `relocation_available`(`PROJECT_RELOCATION_AVAILABLE`)과
    `projectLocation.byteRepair`를 보고합니다. status와 대화 진입은 아무것도 쓰지
    않습니다. resume 결과의 `byteRepair`가 복구한 내용을 보고합니다.
  - 관리 파일이 줄 끝 이외의 내용까지 바뀌었거나 없으면 옮겼든 아니든 아무것도
    복구하지 않습니다. resume은 그 파일을 알려 주는 `PROJECT_NOT_READY`로
    거절하고, 옮긴 Project의 대화 진입도 같은 코드와 다음 단계
    `review_managed_projection_drift`로 답합니다.
  - 옮긴 Project의 status와 대화 진입은 이제 hook이 준비하지 않은 Claude Code
    호출을 포함해 모든 호출자에게 `relocation_available`로 답합니다. 이전에는
    그 경우 진입이 `NOT_INITIALIZED`로 답했습니다. 변경 tool은 resume이 새 위치를
    채택하기 전까지 여전히 `NOT_INITIALIZED`로 답합니다.
- 온보딩이 `ready`가 된 뒤 review하고 적용한 문서 변경이나 수락된 Product Policy
  review로 Product Canon이 바뀌어도 status와 대화 진입은 ready 계열 상태를
  유지합니다. 이전에는 온보딩 base와 다른 Canon이 모두
  `ONBOARDING_PRODUCT_CANON_DRIFT`로 읽혔습니다.
  - 온보딩 base 이후에 기록된 review 변경이 base에서 디스크의 Canon까지 하나씩,
    각각 정확히 한 번 쓰이며 이어져야 합니다. `productCanonLineage`가 단계를
    보여 줍니다. 온보딩 pointer는 다시 쓰지 않으며 저장된 기록 형식은 바뀌지
    않았습니다. review된 되돌리기(A→B→C→B, A→B→A→B)도 인정합니다.
  - 여전히 drift인 경우: 손으로 고친 Canon(이전 review 결과로 손으로 되돌린
    경우와, review 변경은 다른 곳에서 끝났는데 손으로 base로 되돌린 경우 포함),
    review했지만 적용하지 않은 변경, Canon 쓰기를 마치지 못한 수락된 Product
    Policy review, base에서 시작하지 않는 변경. 읽거나 검증할 수 없는 기록은
    `ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE`입니다.
  - 한계: 마지막 review 결과와 정확히 같은 바이트를 손으로 쓴 경우는 review
    변경과 구별할 수 없습니다. World snapshot은 로컬에만 있고 git으로 추적하지
    않으므로 새로 clone한 project에서는 어떤 변경이 base 이전인지 알 수 없습니다.
    이때 Canon이 base와 같으면 이전처럼 ready로 읽히고, base 이전 변경이 기록된
    project의 Canon이 base와 다르면 drift로 읽힙니다.

## 0.3.0-beta.118 — 게시 결과는 별도 확인

- 대소문자를 구분하지 않는 파일 시스템에서, 디렉터리 이름이 기록된 Project
  루트와 대소문자만 다른 루트가 이제 그 Project에 도달합니다(MCP
  `project_root`, CLI 루트, Host가 훅에 넘기는 `cwd`, OpenCode 플러그인
  디렉터리). 이전에는 상태 조회가 재배치를 제안했고 다른 작업은
  `NOT_INITIALIZED`로 답했습니다.
  - 실제 디스크 철자는 주어진 루트로 Project를 찾지 못했을 때만 확인하며,
    그때 요청을 기록된 철자로 한 번 더 실행합니다. 주어진 대로 찾은 Project는
    추가로 읽는 것이 없습니다. 저장된 것은 다시 쓰지 않습니다.
  - 옮겨진 Project와, 기록된 뒤 대소문자만 바꿔 이름을 바꾼 폴더는 여전히
    재배치로 보고합니다.
- Session이 정확히 하나인 Project에서 새 Claude Code 대화는
  `lode_conversation_enter` 한 번으로 그 Session의 저장된 방향을 받습니다
  (이전에는 두 번). 연결은 쓰지 않습니다.
  - SessionStart Hook은 여전히 아무것도 고르지 않고
    `reasonCode: SINGLE_SESSION_ENTRY_AVAILABLE`과 다음 호출
    `lode_conversation_enter`를 알려 줍니다. Skill 진입 표에 해당 행이
    생겼습니다. 시작 맥락은 52자 길어졌습니다.
  - PreToolUse 훅이 준비하지 못한 Claude Code 호출에도 같게 적용됩니다.
  - Session이 둘 이상이거나 연결이 lost, pending, corrupt 또는 로컬 미확인
    상태이면 결과는 그대로이며 사용자가 고릅니다. 연결 없이 답을 받은 대화는
    두 번째 Session이 생기면 Session을 골라야 합니다.
- `scripts/audit-metrics.mjs`가 재개 호출 수를 셀 때 각 단계가 돌려준 상태를
  따라갑니다. `docs/rule-surface-audit.md`를 다시 측정했습니다.

## 0.3.0-beta.117 — 게시 결과는 별도 확인

- Windows에서 Host가 드라이브 문자가 소문자인 프로젝트 폴더를 넘겨도 대문자로
  기록된 Project에 도달합니다. Claude Code와 Codex 훅의 `cwd`(세션 시작
  컨텍스트, 프롬프트·종료·압축 관측, Codex fork 연결), OpenCode의
  `directory`(컨텍스트, 관측, 대화 메시지), Claude Code 도구 훅이 넘기는
  `native_project_root`가 해당합니다. 저장된 것은 다시 쓰지 않으며, 실제로
  옮겨진 Project는 여전히 재배치로 보고합니다.
  - 디렉터리 이름의 대소문자는 그대로이며, 아직 Project가 아닌 폴더는 여전히
    넘겨받은 표기로 비교합니다.
- 규칙 표면 수치를 출력하는 `scripts/audit-metrics.mjs`를 추가했습니다. 항상
  읽히는 지침 크기, 금지 표현 수, 도구 수, `tools/list` 크기, 저장·재개·위임에
  필요한 호출 수를 냅니다. 출력만 하며 한도를 두지 않습니다.
- `docs/rule-surface-audit.md`와 `docs/original-head-core-comparison.md`를 현재
  상태에 맞게 다시 썼습니다. 비교는 현재의 원본 저장소를 기준으로 하며, Lode가
  무엇을 왜 더했는지 기록합니다.

## 0.3.0-beta.116 — 게시 결과는 별도 확인

- Windows에서 드라이브 문자가 소문자인 MCP `project_root`나 CLI 루트는 대문자로
  기록된 Project와 같은 Project로 처리합니다. 이전에는 상태 조회가 재배치를
  제안했고 다른 작업은 `NOT_INITIALIZED`로 답했습니다. 저장된 것은 다시 쓰지
  않으며, 실제로 옮겨진 Project는 여전히 재배치로 보고합니다.
  - 소문자 드라이브로 기록된 Project는 여전히 기록된 표기로만 접근합니다.
    디렉터리 이름의 대소문자와 Host가 훅에 넘기는 `cwd`는 그대로입니다.
- 읽기 전용 거절 코드 감사(`scripts/audit-reason-codes.mjs`,
  `docs/reason-code-audit.md`)를 추가했습니다. 병합 후보는 이후 결정을 위한
  제안이며, 동작은 바뀌지 않습니다.
- `scripts/lib` 모듈을 `scripts/lib-layers.json`에 적힌 계층 디렉터리(`core`,
  `storage`, `world`, `session`, `runtime`, `worker`, `distribution`)로
  옮겼습니다. `scripts/lib/head-core.mjs`와
  `scripts/lib/lode-artifact-composition.mjs`는 경로를 유지합니다.
  - 테스트가 상위 계층 import나 정적 순환이 새로 생기는 것을 막습니다. 현재의
    예외(정적 147개, 동적 30개)는 줄어들기만 하는 목록으로 둡니다. 엄격한
    계층화에는 아직 이르지 못했습니다.
- Conformance disposition MCP 스키마가 `actor: "lode"`를 받습니다(`"head"`는
  별칭으로 남습니다).

## 0.3.0-beta.115 — 게시 결과는 별도 확인

- MCP에서 Host가 검증한 호출자는 자신의 결과가 현재 공통 방향을 보여 준 뒤에는
  `lode_project_direction_update`의 `expected_direction_id`를 생략할 수 있습니다.
  해당 결과는 `lode_project_status`, `lode_conversation_enter`,
  `lode_project_initialize_or_resume`, 그리고 자신의 방향 갱신입니다. 서버는 그
  방향 id를 호출자와 Project 단위로 메모리에만 보관합니다.
  - `lode_checkpoint_basis`와 저장 성공 결과는 방향 id만 보여 주고 방향 내용은
    보여 주지 않으므로 보관하지 않습니다. 방향 충돌은 보관된 id를 버리며,
    보관된 것이 없으면 생략은 여전히 현재 방향 없음을 뜻합니다.
  - 명시한 값(`null` 포함), 검증되지 않은 호출자, CLI는 그대로입니다.
- 검증된 호출자 자신의 방향 갱신은 더 이상 다음의 id 없는
  `lode_checkpoint_sync`를 충돌시키지 않습니다(0.3.0-beta.114의 동작을
  바꿉니다). 보관한 basis 이후의 변경이 그 갱신뿐이면, 서버는 그 Project에서
  해당 호출자가 가진 각 Session의 보관 basis를 메모리에서만 다시 맞춥니다. 그
  사이에 다른 변경이 있으면 여전히 충돌입니다.
- Claude Code에서 `PreToolUse` 헬퍼가 `lode_project_direction_update`에 대해서도
  호출자 검증을 준비합니다. 준비에 실패하면 호출은 이전 버전과 같이 동작합니다.

## 0.3.0-beta.114 — 게시 결과는 별도 확인

- MCP에서 Host가 검증한 호출자가 `lode_conversation_enter`(준비 완료)나
  `lode_project_initialize_or_resume`으로 진입하면, `expected_recovery_basis_id`
  없이 `lode_checkpoint_sync` 한 번으로 복구 방향을 저장합니다. 진입 뒤 첫
  저장에 `lode_checkpoint_basis`가 더는 필요하지 않습니다. 서버는 그 진입 때
  읽은 basis를 메모리에만 보관하며 결과에는 넣지 않습니다.
  - `conflict`나 `deferred` 결과는 이를 버립니다. 호출자 자신의 방향 갱신이나
    Run·리뷰 변경은 다음의 id 없는 저장을 충돌시키므로,
    `lode_checkpoint_basis`를 읽거나 다시 진입한 뒤 방향을 새로 도출합니다.
- 보관한 복구 basis는 더 이상 1시간 뒤에 만료되지 않고, 크기 제한(1024개)만
  남습니다. 더는 현재 값이 아닌 basis는 사용할 때 충돌로 드러납니다.
- 보관 basis는 네이티브 브리지만, 요청 하나 단위로 공급할 수 있습니다.
  임베더가 `dispatch()`에 넘긴 `recoveryBasisMemory` 옵션은 브리지 유무와
  관계없이 무시됩니다.

## 0.3.0-beta.113 — 게시 결과는 별도 확인

- MCP에서 Host가 검증한 호출자는 `lode_checkpoint_basis`나 `created` 동기화
  뒤에 `expected_recovery_basis_id` 없이 `lode_checkpoint_sync` 한 번으로 복구
  방향을 저장할 수 있습니다. 서버는 같은 Project와 Session에 대해 그 호출자에게
  마지막으로 건넨 basis를 보관했다가 넘겨받은 것과 똑같이 사용하므로, 충돌
  검사는 그대로입니다.
  - 보관 값은 메모리에만 있습니다(최대 1024개, 각 1시간). `conflict`나
    `deferred` 결과는 이를 버립니다.
  - 보관된 값이 없으면 새 사유 코드 `RECOVERY_BASIS_NOT_HELD`로 거부하며,
    메시지가 `lode_checkpoint_basis`를 알려 줍니다. 아무것도 쓰지 않습니다.
- 명시적 id, 검증되지 않은 호출자, CLI의 동작은 전과 같습니다.

## 0.3.0-beta.112 — 게시 결과는 별도 확인

- `docs/ko/mcp-surface.md`는 이제 다른 action만 쓰는 필드가 선택한 action에서
  쓰이지 않는다고 적습니다. 대부분의 작업은 이를 무시하고 일부는 거부합니다
  (예: `lode_project_bundle`). 또한 `PreToolUse` matcher가 효과가 있거나
  Session에 묶인 작업의 폐기 예정 이름만 포함한다고 적습니다.
- `verify-conversational-onboarding`은 실제로 호출한 묶음 도구와 action을
  보고합니다. 예: `lode_context (action: prepare)`.
- 테스트: Hook 상관관계가 없을 때 읽을 수 있는 단언 오류로 실패하고,
  discovery는 둘 이상의 접두사 아래에 나오는 도구가 `lode_projection`뿐임을
  확인합니다.

## 0.3.0-beta.111 — 게시 결과는 별도 확인

- 도구 결과의 안내가 폐기 예정 이름 대신 묶음 도구와 action을 알려 줍니다.
  구조화된 안내는 받은 그대로 호출할 수 있고
  (`mcpTool: "lode_onboarding"`과 `mcpArguments: { action: "guide" }`,
  `{ tool: "lode_session", arguments: { action: "work_read", … } }`), 문장으로 된
  안내는 `lode_session (action: work_read)`처럼 적습니다.
- doctor의 `MCP:` 줄에 action이 함께 표시됩니다.
- World 상태의 `boundedDetailTools`는 도구 이름 문자열 목록에서
  `{ tool, arguments }` 항목 목록으로 바뀌었습니다. 도구와 action을 알려 주며,
  `project_root`와 질의는 호출하는 쪽이 채웁니다.
- 폐기 예정 이름은 0.5.0 전까지 그대로 동작합니다. 바뀐 것은 안내 문구뿐입니다.
- `recovery-workflow` Skill 참조 문서가 `lode_project_native_history` 작업과 그
  action을 이름으로 밝히고, Codex는 register에서만 `runtime_root`를 받는다고
  적습니다. `lode_checkpoint_diagnose`가 모델을 호출하지 않고 잠금이나 캐시를
  쓰지 않으며 매 턴 확인용이 아니라는 점도 다시 적었습니다.

## 0.3.0-beta.110 — 게시 결과는 별도 확인

- `conversation-ux` Skill 참조 문서를 절차 형태로 다시 썼습니다. 언제 읽는지,
  번호가 붙은 단계, 실패했을 때 할 일로 구성됩니다. 23,729자에서 11,972자로
  줄었고, 강한 금지 표현("never", "do not", "must not", "cannot")은 50개에서
  6개가 되었습니다. 도구 호출 순서와 인자는 바뀌지 않았습니다.
- Product 증거의 세부 내용은 이를 정의하는 문서로 연결하고, 보호 대상 결정에서
  침묵은 답이 아니라고 명시했습니다.
- `recovery-workflow` Skill 참조 문서를 절차 형태로 다시 썼습니다. 13,014자에서
  8,907자로 줄었고, 강한 금지 표현은 36개에서 4개가 되었습니다. 체크포인트,
  압축, 네이티브 기록, 인계 절차는 바뀌지 않았습니다.
- 세부 내용은 Project 이식성 문서와 Session 복원 문서로 연결합니다.
- `runtime-composition` Skill 참조 문서를 절차 형태로 다시 썼습니다. 19,581자에서
  13,539자로 줄었고, 강한 금지 표현은 31개에서 8개가 되었습니다. 위임, 계획 보존,
  `wait_threads`, 인계, 메시징, 관리형 실행 절차의 도구 호출 순서와 인자는
  바뀌지 않았습니다. 일부 예시와 "새 의식 없음" 문장은 지우거나 완화했습니다.
- 어댑터 구조는 런타임 어댑터 문서와 아키텍처 문서로 연결합니다.
- `project-discovery` Skill 참조 문서를 절차 형태로 다시 썼습니다. 12,511자에서
  10,487자로 줄었고, 강한 금지 표현은 21개에서 4개가 되었습니다. API 세부
  내용은 그래프 탐색 문서로 연결합니다.
- 이 핵심 Skill 참조 문서 네 개를 합치면 68,835자에서 44,905자로, 강한 금지
  표현은 138개에서 22개로 줄었습니다.

## 0.3.0-beta.109 — 게시 결과는 별도 확인

- 항상 로드되는 Lode 지침을 진입 문단과 행동 문장 6개로 다시 썼습니다. 생성되는
  `lode-instructions.md`와 프로젝트의 관리 대상 `AGENTS.md` / `CLAUDE.md`에
  들어가는 글입니다. 8,381자에서 2,301자로 줄었고, "never" / "do not"은 13개에서
  1개가 되었습니다. 기존 Project는 이 버전으로 수렴할 때 새 글을 받습니다.
- 진입 문단은 MCP 서버 `instructions`와 시작 시 `coreGuidance`로도 쓰입니다.
  749자에서 822자로 늘었습니다.
- 지침에 Run을 여는 기준이 들어갔습니다. 지속되는 소유권, 중단 뒤 복구, 결과를
  알 수 없는 효과의 추적, 중복 통합 방지가 필요할 때만 엽니다. Run 동작은
  바뀌지 않았습니다.
- 한 절차에만 해당하는 지침은 더 이상 항상 로드되지 않습니다. Skill과 그 참조
  문서에 남아 있습니다.

## 0.3.0-beta.108 — 게시 결과는 별도 확인

- MCP 탐색과 관리용 도구 목록이 남은 라우팅 작업을 자원 단위로 묶고 `action`
  으로 고릅니다. 묶음 도구 21개가 새로 생겼습니다(`lode_product`,
  `lode_metric`, `lode_projection`, `lode_compact`, `lode_observation` 등). 나열
  카탈로그는 130개에서 50개로, 관리용 도구 목록은 133개에서 53개로 줄어듭니다.
  기본 도구 22개는 변하지 않습니다.
- 대체된 작업 이름 101개(와 `head_*` 표기)는 0.5.0까지 직접 호출과 라우터 경유
  모두 가능합니다. `docs/mcp-surface.md`가 모든 action과 폐기 이름의 대응표를
  담습니다. 일부 작업 결과는 다음 도구를 아직 폐기 이름으로 안내합니다.
- 탐색 접두사 개수가 각 접두사가 실제로 반환하는 도구 수와 같습니다.
- 문서와 스킬이 묶음 도구와 action 이름을 씁니다.

## 0.3.0-beta.107 — 게시 결과는 별도 확인

- 테스트와 검증 스크립트가 지침, 문서, 스킬, 도구 설명의 문장을 더 이상
  고정하지 않습니다. 구조 검사는 그대로 남습니다: 생성물이 커밋된 파일과
  같은지, 링크와 앵커가 해석되는지, 영문과 한국어 문서의 구조가 같은지, 도구
  이름과 스키마가 작업 계약과 같은지.
- 문서 링크와 영문/한국어 구조 검사가 이제 CI에서 실행됩니다.

## 0.3.0-beta.106 — 게시 결과는 별도 확인

- 네이티브 Claude Hook 도우미 `lode_session_host_request_prepare`를 `tools/list`와
  카탈로그에서 뺐고, 탐색과 라우터로도 닿지 않습니다. 기본 도구는 22개(이전 23개),
  나열 카탈로그는 130개(이전 131개)입니다. 함께 배포되는 PreToolUse Hook은 여전히
  도우미를 호출하며, 모델의 직접 호출은 그대로 `NATIVE_HOOK_INGRESS_REQUIRED` 또는
  `NATIVE_HOOK_DIRECT_INGRESS_REQUIRED`로 거절됩니다.
- Claude Code가 목록에 없는 도구를 Hook에서 호출할 수 있다는 점은 Claude Code
  2.1.317의 `UserPromptSubmit`에서만 확인했고, `PreToolUse`와 다른 버전은 확인하지
  못했습니다. Host가 거절하면 네이티브 Session 연결은 Hook이 없는 클라이언트처럼
  호출자 정보 없음 경로로 넘어갑니다.

## 0.3.0-beta.105 — 게시 결과는 별도 확인

- MCP 탐색이 작업을 자원 단위로 묶고 `action` 열거형으로 고릅니다. 첫 대상은
  `lode_bounded_worker`, `lode_bounded_worker_job`, `lode_bounded_worker_wave`
  입니다. 묶인 호출은 어떤 검사보다 먼저 구성 작업으로 바꿔 쓰이므로 결과·오류·
  효과는 그대로입니다. 기본 도구 23개는 변하지 않고, 나열 카탈로그는 144개에서
  131개로 줄어듭니다.
- 대체된 이름(`lode_bounded_worker_prepare` … `lode_bounded_worker_wave_abandon`
  과 `head_*` 표기)은 0.5.0까지 직접 호출과 라우터 경유 모두 가능합니다. 탐색은
  이를 `deprecatedAliases`로 보여 주고 도구로는 더 이상 나열하지 않습니다.
- 새 문서 `docs/mcp-surface.md`가 묶인 action과 폐기 이름의 대응표를 담습니다.
  `node scripts/generate-mcp-surface-docs.mjs --check`로 최신 상태를 확인합니다.
- `lode_tools_call` 설명이 `lode_tools_read`를 가리킵니다.

## 0.3.0-beta.104 — 게시 결과는 별도 확인

- `.lode` 프로젝트도 파생 지식 그래프 색인 문서의 제목을 "LODE Agent derived
  knowledge graph"로 씁니다. `.head` 프로젝트가 0.3.0-beta.102부터 쓰는 문자열과
  같습니다.
- 각 방언의 이전 제목("Lode Agent derived knowledge graph"(`.lode`), "HEAD Agent
  derived knowledge graph"(`.head`))으로 저장된 Markdown 투영은 그래프가 그대로인
  동안 의미 불일치 오류 대신 `stale`(`staleReason: "earlier-index-heading"`)로
  보고됩니다. 다음 `world-docs-build`가 새 제목으로 다시 씁니다. 저장된 기록은
  이관하지 않습니다.

## 0.3.0-beta.103 — 게시 결과는 별도 확인

- 분리 실행 워커 소유자의 `stderr.bin` 실패 줄이 실패한 파일 작업(`syscall`,
  `path`, `dest`, `errno`)과 스택을 담아 간헐적 파일 시스템 오류의 위치를 찾을
  수 있습니다.
- 동시 presence 재작성 테스트를 프로세스당 40회로 제한해 느린 러너에서 잠금
  기아가 아니라 이름 바꾸기 경합을 검사하도록 했습니다.

## 0.3.0-beta.102 — 게시 결과는 별도 확인

- 소스 코드가 wire 프로토콜·레코드 종류·저장 값을 Lode 철자로 부릅니다. 구
  `head-*` 철자는 `compat/head/format.mjs`의 역방향 표에서 만듭니다. `.lode`·`.head`
  어느 방언이든 디스크에 쓰는 바이트는 그대로이고, 읽을 때는 양쪽 철자를 모두
  받아들입니다.
- 저장되는 검토 필드 `freshHeadReviewRequired`, 캐논 커버리지 값
  `curated-head-canon(-only)`, Todo 출처 `head-proposed`에 Lode 철자
  (`freshLodeReviewRequired`, `curated-lode-canon(-only)`, `lode-proposed`)가
  생깁니다. `.lode` 프로젝트는 새 철자를 쓰고 `.head` 프로젝트는 옛 철자를 유지하며,
  읽기는 둘 다 받아들입니다. Todo 출처 입력 enum에 `lode-proposed`가 추가됩니다.
  순방향 호환은 유지되지 않습니다. 이 버전이 쓴 `.lode` 프로젝트를 0.3.0-beta.101
  이하가 읽으면 새 실행 authorization 필드를 거부하고 `lode-proposed` Todo를
  unavailable로 표시합니다. `.head` 프로젝트는 영향이 없습니다.
- `.head` 프로젝트가 쓰는 파생 지식 그래프 문서의 제목은 "LODE Agent derived
  knowledge graph"입니다.

## 0.3.0-beta.101 — 게시 결과는 별도 확인

- 런타임 오류·안내 문구가 에이전트를 HEAD 대신 Lode라고 부릅니다. `.head`
  프로젝트의 문서 제목 "HEAD Agent derived knowledge graph"와 고정된 Codex 제안
  지시문은 그대로입니다.
- 보고되는 상태·행동·안내 값은 Lode 이름을 씁니다(예: `lode-selection-required`,
  `refresh-lode-assessment`, `Lode-owned`). CLI 표시는 옛 상태 철자도 계속
  받아들입니다.
- CLI 명령은 `lode-continuity`이며 `head-continuity`는 별칭으로 남습니다.

## 0.3.0-beta.100 — 게시 결과는 별도 확인

- 이유 코드에서 옛 제품 이름을 뺍니다. `HEAD_X`는 `X`가 되고, 아홉 개 코드의
  안쪽 `_HEAD_` 구간도 빠집니다. 한 버전 동안 MCP `error.data`와 CLI JSON 실패
  결과는 옛 코드를 `legacyReasonCode`로 함께 실어 보냅니다. Git HEAD를 뜻하는
  `UNSUPPORTED_GC_GIT_HEAD`와 `HEAD_*` 환경 변수는 그대로입니다.
- 다음 값은 Lode 이름을 씁니다: 압축 상태 `lode_direction_required`, 컨텍스트
  워크플로 다음 행동 `lode_assess_semantic_sufficiency`, 컨텍스트 워크플로·준비
  상태 `ready_for_lode_semantic_assessment`.
- 문서와 스킬은 Lode 이름을 쓰고, 과거 비교 문서는 HEAD를 옛 이름으로 표시합니다.
  Hook matcher는 구 `head_*` 별칭도 계속 포함합니다.

## 0.3.0-beta.99 — 게시 결과는 별도 확인

- 정식 이름 `lode_*`를 내부 작업 이름으로 삼습니다. 147개 작업 descriptor는
  `scripts/lib/lode-operation-contract.mjs`에 있고, 도구 설명은 목록 시점에 치환하는
  대신 소스에서 "Lode"라고 적습니다. `head_*` 이름은 MCP와 라우터에서 단방향 별칭으로
  계속 받아들이며 `tools/list`, 탐색, Hook, CLI 출력은 바뀌지 않습니다.
- `compat/head/public-names.mjs`를 단방향 구 별칭 규칙과 환경 변수·탐색 접두사 표만
  남기도록 줄입니다. `.head/` 프로젝트 리더는 그대로입니다.

## 0.3.0-beta.98 — 게시 결과는 별도 확인

- 모든 CLI 명령을 operation registry로 디스패치합니다. `scripts/lode.mjs`에는 더
  이상 명령별 분기가 없고, CLI 전용 명령은 MCP 도구가 없는 레지스트리 항목이며
  여러 이름을 가진 명령은 레지스트리 별칭을 씁니다. 도움말·버전·오류 출력과 호출은
  바뀌지 않습니다.
- 디스패치 녹화에 `caller` stand-in과 문서 prepare/publish 명령을 기록하고, 핸들
  전용 항목의 구현 호출은 명시적으로 거부합니다.

## 0.3.0-beta.97 — 게시 결과는 별도 확인

- 모든 MCP 도구를 operation registry로 디스패치하며, 레지스트리가 MCP 도구 목록
  자체가 됩니다. `mcp-server.mjs`의 삼항 디스패치 체인을 제거했고, 마지막 32개 MCP
  작업을 어댑터와 함께 옮겼으며 `project_status`와 conformance trigger 도구는 명시적
  핸들러로, `world_model`의 4 MiB 응답 상한은 같은 지점에서 검사하는 레지스트리
  필드로 옮겼습니다. 동작 변경은 없습니다.
- Claude hook matcher를 operation registry에서 생성하고 선언된 `project_root`
  스키마도 거기서 읽습니다. CLI 명령 분기는 다음 릴리스까지 남아 있습니다.

## 0.3.0-beta.96 — 게시 결과는 별도 확인

- 44개 작업을 추가로 operation registry로 디스패치합니다(144개 중 111개): project
  direction, onboarding, product policy·operating loop, conformance 읽기, source와
  context, Session 복구 읽기, World·GraphDB 상태, 문서 변경 읽기, 대화 진입, compaction
  lifecycle 단계, observation prepare/collect. 호스트 값은 이전과 같은 표면에서 호출
  컨텍스트로 전달되며 동작 변경은 없습니다.
- 디스패치 녹화에 호스트 값, `=== "true"` 옵션 분기, 옵션으로 조립한 CLI 입력을
  식별 가능한 stand-in으로 기록합니다.

## 0.3.0-beta.95 — 게시 결과는 별도 확인

- operation registry 항목이 표면별 `before`/`after` 어댑터를 선언할 수 있습니다.
  MCP의 명시적 확인, 압축 결과, 준비 입력 뷰가 이전과 같은 순서로 어댑터를 통해
  실행되며 동작 변경은 없습니다.
- run 시작, release 관찰, feature mapping, onboarding 검토, Markdown 투영 빌드,
  bounded-worker 상태·준비·시작, runtime 승인 읽기, product initiative, observation
  ingest/derive, conformance 제안을 레지스트리로 디스패치합니다(144개 중 67개). 공용
  어댑터 헬퍼는 `scripts/lib/dispatch-adapters.mjs`에 있습니다.
- 거부된 MCP 확인을 디스패치 녹화에 기록하고, 파생 Observation 확인 거부를 직접
  단언합니다.

## 0.3.0-beta.94 — 게시 결과는 별도 확인

- measurement, delivery, release 상태, refresh 영수증·상태, observation
  읽기·질의·출처 작업을 operation registry로 디스패치합니다(144개 중 50개). 두 표면
  모두 동작 변경은 없습니다.
- 디스패치 녹화에 숫자 edge 한도와 `--include-execution false` 경우를 기록하고,
  문서 흐름 검사가 진입 상태를 core Skill 진입 표의 온전한 토큰으로 대조합니다.

## 0.3.0-beta.93 — 게시 결과는 별도 확인

- checkpoint, compaction, graph-lineage, change-set, lineage 읽기 작업을 operation
  registry로 디스패치합니다(144개 중 32개). 두 표면 모두 동작 변경은 없습니다.
- MCP 서버와 레지스트리가 함께 쓰는 Session 작업 증거 스키마 조각을
  `scripts/lib/tool-schemas.mjs`에 둡니다.
- 디스패치 녹화에 숫자 대기 시간과 지원하지 않는 JSON 입력 필드를 기록하고,
  레지스트리로 쓰이지 않게 된 CLI import를 제거하며, 문서 흐름 검사가 진입 상태를
  core Skill의 진입 표와 대조합니다.

## 0.3.0-beta.92 — 게시 결과는 별도 확인

- MCP 서버와 CLI가 함께 거치는 단일 레지스트리 `scripts/lib/operation-registry.mjs`를
  추가합니다. bounded-worker의 job·dispatch·wave 작업 15개가 먼저 사용하고, 나머지
  작업은 기존 분기를 유지하며 호출과 도구 정의는 바뀌지 않습니다.
- 모든 MCP 도구와 CLI 명령이 어떤 라이브러리 호출을 하는지
  `test/fixtures/dispatch-recordings.json`에 고정하고
  `test/dispatch-recordings.test.mjs`가 검사합니다.
- README의 첫 요청 흐름을 합성 프로젝트에서 CLI와 MCP로 실행해 양쪽의 `status`,
  `reasonCode`, `nextAction`이 같은지 확인하는 `scripts/verify-documented-flow.mjs`를
  추가하고, 문서가 그 흐름의 결과 상태 이름을 적습니다. CI가 실행합니다.

## 0.3.0-beta.91 — 게시 결과는 별도 확인

- SHA-256 다이제스트, 정규화 JSON, 오류와 이유 코드, 원자적 쓰기, 경로 탈출
  검사를 위한 공용 `scripts/lib/core/` 헬퍼를 추가하고 `scripts/lib`의 중복
  지역 헬퍼를 그 위로 옮깁니다. 다이제스트 바이트·메시지·코드·파일 효과는
  그대로이며, lint 테스트가 라이브러리에서 raw `createHash`, `renameSync`,
  지역 digest 헬퍼를 막습니다.
- `scripts/lib/core/errors.mjs`의 `REASON_CODES`는 `code`/`reasonCode` 값이나
  fail/error 호출 인자로 쓰인 이유 코드를 나열하며 테스트가 코드와 동기화를
  유지합니다.

## 0.3.0-beta.90 — 게시 결과는 별도 확인

- 모든 JavaScript 소스를 Prettier 3.9.10(`printWidth` 160, 나머지 기본값)으로 한
  번 포맷합니다. JSON·Markdown·텍스트·테스트 픽스처의 바이트는 그대로입니다.
  `.prettierrc`, `.prettierignore`, `.editorconfig`가 스타일을 기록하고,
  `npm run format` / `format:check`는 의존성 없이 npx로 버전을 고정하며,
  JavaScript CI 잡이 포맷을 검사하고 `.git-blame-ignore-revs`가 포맷 커밋을
  blame에서 숨깁니다.
- 두 TAP 실행의 실패 테스트 집합 차이를 보여 주는
  `scripts/compare-test-baseline.mjs`를 추가합니다. 일부 스위트가 항상 실패하는
  머신에서도 절대 개수가 아니라 기준 대비 새 실패로 브랜치를 판정합니다.

## 0.3.0-beta.89 — 게시 결과는 별도 확인

- Lode Skill을 진입 절차로 바꿉니다. core Skill은 진입 상태(`conversation_ready`,
  `session_selection_unresolved`, `NOT_INITIALIZED` 또는 `PROJECT_RELOCATION_*`를
  동반한 `conversation_recovery_unavailable`, MCP `error.data.reasonCode`)에서
  호출할 도구와 결과 사용법으로 이어지는 표로 시작하고, 권한 독트린은
  `docs/lode-constitution.md`를 링크하는 한 줄 규칙만 남깁니다. conversation
  Skill은 결과 필드를 문장으로 대응시키는 표가 되고, onboarding Skill은 모든
  `nextAction` 값을 나열합니다.
- 모든 설치에 존재하는 진입점 `node <plugin-root>/scripts/lode.mjs …`를
  `nextAction.entrypoint.cli`와 준비 안내에 사용합니다. CLI 도움말은 선택적인
  `lode-agent` 런처 철자를 설명합니다.
- `hooks/claude.json`의 PreToolUse matcher를 도구 목록에서 생성하고
  (`scripts/generate-claude-hooks.mjs`, `--check`) 테스트가 바이트 단위로
  확인합니다. 전체 목록에서 만들므로 Hook이 `lode_tools_read` / `lode_tools_call`과
  나머지 라우터·탐색 도구에도 실행됩니다.
- `docs/glossary.md`(한국어 포함)를 추가하고, README를 무엇·왜, 두 가지 설치,
  첫 요청, 용어집으로 시작하도록 바꾸며, `session-create --new-session`,
  `checkpoint-sync`, `session-work-record --input`의 필수 키와 형식을 문서화합니다.
  검증 오류는 문제가 된 키나 기대 형식을 이름하며 이유 코드는 그대로입니다.

## 0.3.0-beta.88 — 게시 결과는 별도 확인

- 모든 MCP 도구가 선언한 `project_root` 인자를 디스패치 전에 강제합니다. 없거나
  비었거나 문자열이 아닌 루트는 서버의 현재 디렉터리로 조용히 해석되거나 Node
  `TypeError`로 드러나는 대신 `INVALID_TOOL_ARGUMENTS`로 거부합니다. 라우터 경유
  호출은 라우터의 형태·읽기 전용 검사 뒤에 확인합니다. 그 밖의 인자 규칙은 CLI와
  MCP에서 동일한, 해당 작업 자체의 거부 메시지를 유지합니다.
- 라이브러리의 이유 코드를 MCP 오류의 `error.data.reasonCode`로 전달해 에이전트가
  메시지 문자열이 아니라 문서화된 코드로 분기할 수 있게 합니다.
- 다른 루트로 기록된 Lode Project가 있는 폴더를 대화 진입과 SessionStart Hook에서
  기존 Project로 보고합니다(`PROJECT_RELOCATION_AVAILABLE`/`PROJECT_RELOCATION_PENDING`,
  다음 행동은 명시적 resume). `status`와 같은 판정입니다. 암묵적 읽기는 여전히
  아무것도 채택하지 않습니다. 초기화되지 않은 폴더의 Session 작업 읽기는 구형
  경로의 `ENOENT` 대신 `NOT_INITIALIZED`로 실패합니다.
- 미해결 진입이 탐색 호출로 지목하는 `lode_session_list`를 기본 목록(23개 도구)에서
  직접 호출할 수 있게 합니다. 온보딩 가이드는 Core가 초기화된 프로젝트에서
  `initialize_or_resume`을 반복하지 않고 `provide_product_evidence`를 답합니다.
  보류된 루트 지침 파일 안내에 `undefined`가 더 이상 찍히지 않습니다.
- 지침 연결이 없는 CLAUDE.md/AGENTS.md를 링크 블록만으로 새로 만든다는 점과,
  기록이 출처를 증명하는 사본은 명시적 resume에서 이동으로 받아들인다는 점을
  문서에 명시합니다.
## 0.3.0-beta.87 — 게시 결과는 별도 확인

- 의미 검증인데 실제 OS의 짧은 종료 시간을 가정하던 나머지 두 시험에 기존
  정리 시계 제어를 적용합니다. 실제 EOF·종료·트리·PID 증명과 제품 정리 정책,
  강제 종료·불확실·비정상 종료 부정 시험은 유지합니다.
- 실제 파일 변경 1회·5초 제한·제품 감시 코드·성공 조건을 유지하면서 시험에만
  제한된 파일 이벤트·처리 단계 진단을 추가합니다. 반복된 macOS 시간 초과의
  근본 원인은 아직 확정되지 않았습니다.
- 실제 제품·중첩 기능그룹·다중 소속 기능을 같은 사람용·에이전트용 문서로
  탐색합니다. 공유 작업·결정은 원문 하나로 연결하고 미확인 소속을 보존하며
  설명문은 처음 인용한 정확한 원문에 고정합니다.
- 세션 간 목적지 ID와 제한된 게시 진행을 공유합니다. 기존 작업 문서·개인 메모·
  안정 페이지·읽기 이력을 보존합니다. 프로젝트 범위는 명시적으로 선택하며
  의미 있는 분석을 문서화할 때 Todo가 필요하지 않습니다.
- 65개를 넘는 문서도 완료한 앞부분을 반복하지 않고 이어갑니다. 결과 불확실과
  정확한 거부 요청의 재시도 경계를 유지합니다. 여러 호출의 생성 응답 유실 검색은
  후보만 보고하며 현재 전체 유일성 판정이나 자동 연결을 하지 않습니다.
- 같은 프로젝트 문서 Core를 typed MCP·CLI·Skill에서 사용합니다. 합성 vault·HTTP
  통과는 실제 Notion이나 로컬 앱 로드를 검증한 것이 아닙니다.

- 무관한 게시에서는 정확히 같은 근거·읽기 뷰의 기존 이력 링크를 재사용합니다.
  원문·공통 방향·중단 복구의 신원을 보존하며 실제 변경은 새 이력을 만들고 사용자
  편집은 drift로 유지합니다.

- 정상 종료 뒤 취소를 검증하는 기존 시험에 전용 정리 시계 제어를 적용합니다. 실제
  EOF·정확한 종료·PID 부재·강제 종료 거부는 유지하며 제품 런타임의 시간 정책과 실패
  판정은 바꾸지 않습니다.

## 0.3.0-beta.82 — 게시 결과는 별도 확인

- 같은 정확한 작업 원문에서 사람용 설명과 에이전트용 Markdown을 준비하고
  이유·조건·실제 변경·미확인을 보존합니다. 기존 작업을 문서화할 때 Product
  온보딩·World 재구축·Run·Todo 도입을 요구하지 않습니다.
- 사용자가 선택한 Notion·Obsidian 목적지를 범위가 정해진 태스크 결과에 연결합니다.
  안정적인 시작 링크·별도 개인 메모·불변 읽기 revision을 제공하며 current 링크는
  마지막으로 확인한 게시 상태이지 태스크 완료나 배포 성공을 뜻하지 않습니다.
- 동일 재시도에서 HEAD의 풍부한 근거·비교·인용·관련 기록 선택을 유지합니다.
  게시 실패와 성공한 원래 작업 저장을 분리하며 필요한 선택은 기존 CLI/MCP 대화
  흐름에서 이어갑니다.
- 확인된 동기 Notion 403 restricted-resource 거부는 동일 요청의 명시적인 후속
  시도로 복구하고 이전 시도와 원인을 보존합니다. 결과 불확실·응답 유실·async 실패·
  거부 저장 실패는 새 쓰기를 허용하지 않습니다. 사용자 편집을 보존하고 게시 증거가
  P2 방향이 되지 않도록 유지합니다.
- 관련 회귀 206개·독립 합성 검수 9그룹·문서/배포 검증기 4종을 통과했습니다.
  실제 Notion·Obsidian GUI는 미검증이며 이전 로컬 전체 시험의 시간 초과는
  미완료로 유지합니다. CI·마켓플레이스 게시 결과는 별도로 확인해야 합니다.

## 0.3.0-beta.81 — 게시 결과는 별도 확인

- 잘못된 대화 레코드를 원본 바이트 그대로 격리하고 같은 배치의 정상 메시지는
  전달합니다. enqueue 전에 caller ticket을 재검증·소비하며 불확실한 전송의
  소비 기록을 재사용하지 않습니다.
- 새 환경 변수 설정 없이 선택한 standalone Claude launcher의 업그레이드·롤백을
  유지합니다. CLI·MCP·배포 초기화와 이후 동의에서 루트 지시·설정 파일 생성을
  명시적인 선택으로 다루고 파일별 소유권과 생성 보류 상태를 보존합니다.
- 정확히 같은 상태 항목의 훅 신뢰 기록만 관측합니다. 지원하지 않는 plugin
  식별자는 미검증이며 일반 작업을 막지 않습니다. 프로젝트 로컬 불신을
  사용자·시스템 훅 전체 비활성화로 해석하지 않습니다.
- 읽기 쉬운 그래프 요약과 전체 raw diff 페이지 조회를 함께 유지합니다.
  명시적인 저장소 추적 선택과 최소 reader 버전 선언을 존중합니다.
- 중복 GC 참조 계산을 줄이고 기존 deadline을 공유합니다. 참조된 이력은
  보존하며 회수 0바이트도 정상 완료일 수 있습니다. macOS 물리 GC는 계속
  미지원이고 실제 무효과 반환을 별도로 검증합니다.
- 세 CI 호스트에서 전체 JavaScript 시험을 실행하고 합성 경로·Git 설정을
  격리합니다. 자동 Go fixture는 현재 소스로 다시 빌드하며 외부 CI fixture는
  호출자 소유로 유지합니다. 실제 Host·MCP 재로드를 뜻하지 않습니다.
- 감사된 경로의 수정이며 과거 병합 404d662 전체의 실제 앱 검토나 모든
  저장소의 속도 향상을 주장하지 않습니다.

## 0.3.0-beta.80 — 게시 결과는 별도 확인

- 기본 portable export에 선택 Session이 정확히 인용한 적격 보관 원문을 포함합니다.
  참조만 이관하는 대안과 참조별 누락 이유를 제공하며, 원문 바이트·식별자와
  대상의 현재 방향을 보존합니다.
- 새 Project·기존 동일 Project 가져오기, 복구, 재내보내기에서 검증된 채택·Session
  영수증을 통해 CLI·MCP·Explorer의 정확한 과거 diff를 연결합니다. 무관한 보관
  번들의 검색 한도 때문에 가져온 정확한 원문을 놓치지 않습니다.
- 구조 응답을 포함한 raw JSON의 모든 깊이에서 중복 키·이스케이프된 동일 키를
  거부합니다. 정상 BOM·공백·CRLF·Unicode 바이트는 그대로 유지하며, 포함을 확정한
  원문 충돌을 생략 성공으로 바꾸지 않습니다.
- 역사 소유 증명 경로에도 manifest 기능 검증을 연결합니다. 구형 번들을 정직한
  원문 coverage와 함께 읽고, 일반 원문·Git 조회 동작은 유지합니다.
- 관련 합성 시험과 독립 검수를 통과했습니다. 물리적 심볼릭 링크 탈출, 파일시스템
  경합 전수 검증, 실제 GUI·네이티브 앱 이어쓰기·성능은 미검증입니다. Git 전용 원문
  수집은 후속으로 분리하며 이관으로 새 Git fetch나 실행·복구 권한을 만들지 않습니다.

## 0.3.0-beta.79 — 게시 결과는 별도 확인

- 검증된 오프라인 어댑터로 선택한 OpenCode session·message·part 전체를 단일
  트랜잭션에 반영합니다. 원본을 보존하며 전역 ID 충돌 시 덮어쓰기·부분 반영·
  불확실한 효과의 자동 재실행을 하지 않습니다.
- 공식 Windows x64 baseline 1.19.5 바이너리와 관측된 격리 DB의 스키마·
  마이그레이션 집합을 결속합니다. 기존 Project 매핑과 대상 설정을 보존하고,
  알려진 메시지·파트 필드, 기존 부모 계보와 실제 SQL 정렬을 검증합니다.
- 독립 검수에서 확인한 다른 Project 부모 연결·기존 순환·정렬 키 변경·보존할 수
  없는 Session 중첩 필드·숨겨진 스키마 객체를 차단했습니다. 읽기 프로세스의
  공존은 허용하고, writer 경합은 별도로 알립니다.
- 관련 로컬 시험 106/106개가 통과했습니다. 별도의 독립 CLI·MCP 시험과 공식
  격리 SQL 조회로 대화 2개·메시지 63개·파트 63개를 대조했으며 합산하지 않습니다.
  Claude 버전·SDK 합성 조회도 실행했습니다. GUI picker·네이티브 이어쓰기·실사용
  DB·모델 호출은 미검증이며, 일반 프로필 대체나 기본 CLI bootstrap은 열지 않습니다.

## 0.3.0-beta.78 — 게시 결과는 별도 확인

- 선택한 Project·Session 번들에 읽기 쉬운 digest 결속 HANDOFF와 단독 조회를
  추가합니다. provider 시작이나 복구 권위 승격을 요구하지 않습니다.
- 같은 플랫폼의 Claude 원문 이력 캡처·복원과 선택적 SDK 조회를 연결하고,
  사전 충돌 검사·정확한 재조회·불확실한 효과의 중복 실행 방지를 적용합니다.
- OpenCode Host export와 격리 import·재조회 인터페이스를 추가합니다. 기본
  CLI bootstrap은 검증 전 사용 불가로 유지하며 일반 프로필 DB writer는 없습니다.
- 원본과 현재 대상 권한·기존 Codex 동작을 보존하고, 부속 파일 경로 충돌·공백
  JSONL·대소문자 구별 ID·부분 실패를 검수했습니다. 로컬 구현과 독립 통합 검토는
  통과했으며 실제 공식 client·SDK 앱 시험·picker 노출·모델 이어쓰기는 제외했습니다.

## 0.3.0-beta.77 — 게시 결과는 별도 확인

- 같은 프로젝트 대화 메시징을 통합하고 목록의 읽기 전용 계약, Host 등록
  수신 대상 검증, caller ticket의 배타적 단일 소비를 보완했습니다.
- 확인이 끊긴 인계는 결과 불명으로 남겨 자동 재전달하지 않으며, 기존 Go
  supervisor로 Codex proxy의 소유 프로세스 트리를 정리합니다. 일반 작업과
  P1–P5 권한, Project·native-history 이관 경계를 유지합니다.
- 사용자 ignore와 실제 beta75 이전 generated 원문을 보존합니다. 합성
  provider 검사는 세 실사용 클라이언트의 전체 검증을 뜻하지 않습니다.

## 0.3.0-beta.76 — 게시 여부는 별도 추적

- 정확한 원본 기록과 참조 계보로 Project·선택 Session을 옮깁니다. 대상의 현재 설정,
  기본 선택, 더 새로운 공통 방향을 보존하며, 확인된 사본·줄바꿈 전환만 복구하고
  초기 출처를 만들어 내지 않습니다.
- 내보내기 전에 범위를 알리고 복구에 필요한 공통 증명의 경로·ID·해시를 기본 포함합니다.
  다른 Session 본문은 제외하며, 명시적인 `selected-only`에서 빠진 증명은 부분 상태로 둡니다.
- 정확한 버전의 선택적 Codex 네이티브 이력 Host 어댑터를 추가합니다. 로컬 사전 백업,
  현재 정책의 메타데이터 검증, 제한된 소유 프로세스 정리, 중복 실행 없는 부분 그룹
  재개를 지원합니다. 실험적 기능이며, 안정적 import API나 실제 모델 이어쓰기·현재
  지침 결속의 증명으로 취급하지 않습니다.
- Core P1–P5와 P2 복구 경계를 유지합니다. 네이티브 등록 증거는 ReviewDecision,
  Canon 승격, Session 소유권, 실행 권한을 만들지 않습니다.

## 0.3.0-beta.75 — 게시 여부는 별도 추적

- 신규 완전 로컬 World/Graph 저장의 기본값을 family를 묶은 `chunked-code-v3`
  (물리 schema 3)로 바꿉니다. whole/v1/v2 원본과 변경 없는 ID는 변환하지 않습니다.
  색인·이력·Compiler·Explorer·CLI/MCP·typed GC가 같은 의미 근거를 복원·검증합니다.
- 사용자의 명시 선택에 따라 저장량을 우선합니다. 파일 48개의 동일 조건 합성
  사례에서 한 줄 수정 신규 저장량은 75.7% 줄었지만 첫 생성은 28% 느렸습니다.
  네 파일 사례는 첫 저장량 28%, 최초 시간 22%, 코드 refresh 시간 23%가 늘었습니다.
  보편적 속도나 Host/model 효과를 주장하지 않습니다.
- Core 준비와 크기가 제한된 advisory reader 지원 안내를 구분하고, 관측한 실제
  파일 길이와 snapshot 전용·회수 가능 용량을 분리합니다. 원본 검증·권한 오류·취소·
  GC deadline은 유지합니다.
- 정확한 기존 생성 ignore만 갱신하고 사용자 편집·관련 예외를 보존합니다. 별도
  retained-history 규칙은 기존 추적을 해제하지 않습니다. 파일 성장 중 fd 읽기를
  제한하고 관계 hash의 임시 할당을 줄이되 canonical 출력은 유지합니다.

## 0.3.0-beta.74 — 게시 여부는 별도 추적

- native 쓰기 큐·EOF 회귀 검사에 기존의 제어 시계를 적용합니다. OS 종료
  이벤트가 66 ms 안에 도착한다고 가정하지 않으면서 정확한 쓰기 순서, EOF
  완료, 정상 native 종료와 프로세스 트리 정리 증명을 유지합니다.
- 제품 transport·native 코드, 설정된 정리 예산(기본 1,000 ms, 이 fixture는
  200 ms)과 강제 종료 실패 판정은 바꾸지 않습니다. 실제 종료 단계와 EOF
  저항 검사의 시계·판정도 유지합니다.

## 0.3.0-beta.73 — 게시 여부는 별도 추적

- 한·영 README를 설치, 첫 작업, 남은 일, 계획 갱신, 기록된 전후 근거 중심으로
  정리합니다. 고급 명령과 계약은 기존 전문 문서로 옮기고 링크를 유지합니다.
- Product profile 예제, Node 요구 버전, Claude 플러그인·standalone 실행 조건과
  현재·과거 World/Graph 프로토콜 설명을 바로잡습니다.
- 공유 schema-2 reader 호환, 명시적 GC, 제한된 Host 참조와 합성 성능 근거의
  한계를 명확히 합니다.
- 런타임 동작과 실행 fixture는 그대로 두고 이동된 문서 계약과 한국어 README
  목적지를 검증합니다.

## 0.3.0-beta.72 — 게시 여부는 별도 추적

- native GC가 기존 수집 deadline 안에서 종료·정리 증명 기록을 마치도록 합니다.
  graceful 종료는 한 번 요청하고, supervisor가 멈췄을 때는 기존 deadline에서
  강제 종료합니다.
- 용량 상한·최초 오류·중단 뒤 쓰기 억제·정리 미확인 표시를 보존합니다. 멈춘
  native 프로세스는 기존 작업 deadline의 남은 시간을 사용할 수 있으며, POSIX
  정리 증명이 없으면 계속 실패로 처리합니다.
- 정리 증명 지연·멈춘 프로세스·일반 취소의 제어된 회귀 사례를 추가하고, 실제
  native 정리를 확인하는 기존의 엄격한 검사는 유지합니다.

## 0.3.0-beta.71 — 게시 여부는 별도 추적

- 부분 작업 맥락의 coverage를 계산할 때 선택된 fragment의 정확한 필드·인덱스
  묶음을 재사용해 렌더마다 반복하던 순회를 줄입니다.
- 원문 내용·선택 ID와 순서·부분 범위·생략 경고·기존 표시 및 fits 콜백 동작을
  보존하며, 새 읽기·영구 cache·런타임 아티팩트·사용자 절차나 게이트를 추가하지
  않습니다.
- 집중 합성 비교에서 전체 startup 출력이 같고 부분 렌더 계산 비용이 줄었습니다.
  검색 품질·의미적 충분성·실제 Host나 모델 활용 개선을 입증하는 결과는 아닙니다.

## 0.3.0-beta.70 — 게시 여부는 별도 추적

- 선택된 Project 소유 근거로 저장하는 새 완전한 World/Graph 스냅샷은 flat 공유
  코드 묶음을 사용합니다. 의미 식별자와 기존 whole/Git/v1 이력을 보존하며,
  순수 하위 adapter는 새 설정 없이 whole 문서 저장을 유지합니다.
- 손상된 optional World/Graph는 Product 무결성 주의 상태로 표시하고 Core 준비
  상태를 유지합니다. 명시적 Product 작업은 정확한 오류와 손상 원본을 보존합니다.
- CLI/MCP/Explorer에서 변경 없는 파일 소속과 내용 변경을 구분합니다. 원시 끝점·
  개수·페이지를 유지하고 예제 생략 개수를 표시합니다.
- 기존 예외와 겹치지 않는 ignore 규칙만 생성하고 사용자 파일·추적 정책을
  보존합니다. private Git 읽기를 묶고 검증된 요청 소유 끝점을 재사용하되
  영구 cache나 소유 검증 완화를 추가하지 않습니다.
- 균형 순서의 로컬 합성 측정에서 결정 변경의 저장 증가량과 첫 조회가 줄었지만
  일부 반복·소규모 작업은 느려졌습니다. 전체 속도 향상은 주장하지 않으며
  P2b와 Rust 실험 경로는 채택하지 않습니다.

composition schema 2를 지원하는 reader가 필요합니다. beta.69 이하는 새 형식을
거부하므로 공유 저장소에 v2를 쓰기 전 모든 클라이언트를 업데이트하세요.
게시·설치·활성 Host/MCP 로딩은 각각 구분합니다.

## 0.3.0-beta.69 — 게시 여부는 별도 추적

- 새 World/Graph 계보에서 내용 변경과 스냅샷 소속 변경을 구분해 설명하고 정확한
  원시 근거를 유지합니다. 소스·기준 검증 뒤에만 분석을 재사용하며, 검증된 내용이
  같으면 기존 불변 World/Graph 식별자를 재사용할 수 있습니다.
- 프로젝트 ignore 예외와 무관한 OpenCode 설정을 보존합니다. 현재 Host의 로딩을
  추정하지 않고 로컬 연결 준비 상태를 표시하며, 종료 코드·정책 변경 없이 기존
  정리 결과를 읽기 쉽게 설명합니다.
- 그래프 노드가 없어도 정확히 요청한 Git/LFS 자료를 소스 비교·터미널·Graph
  Explorer에 연결합니다. 포인터 신원·로컬 캐시 존재·본문 검증을 구분하고
  원격 자료를 암묵적으로 가져오지 않습니다.
- 상호 메타데이터를 검증한 linked worktree와 외부 공통 디렉터리를 읽습니다.
  private 스냅샷 저장소는 이 지원과 분리해 유지합니다.
- 이번 범위의 독립 소스·합성 소비 경로·브라우저 근거를 확보했습니다. 후속 batch·
  범위 성능 실험은 제외합니다. 게시·설치·Host/MCP 로딩은 각각 확인합니다.

## 0.3.0-beta.68 — 게시 여부는 별도 추적

- 큰 단계별 작업에서 완료된 계획 source 보존, 필요한 구현·검수 기여, 판단 통합을
  기존 일반 Host 도구로 연결합니다. 작은 직접 작업과 현재 권한은 그대로 유지합니다.
- 최초 계획을 반복하거나 상세 검수 이력을 다음 기획으로 승격하지 않고,
  통합된 결과와 새 사실을 반영해 다음 계획을 갱신합니다.
- native 이력 관측·기록 재구성·실제 Host 동작·모델 품질 근거를 구분합니다.
  새 API·기록·사용자 승인 의식 없이 기존 복구·관리형 실행 계약을 유지합니다.

## 0.3.0-beta.67 — 게시 여부는 별도 추적

- 참조 검증을 거친 명시적 로컬 정리로 orphan World·Graph 파일, private Git
  ref·객체, domain bundle을 회수합니다. 현재·역사 원본, 정확한 byte pin, 복구
  기록과 성공·실패 source 원본은 보존합니다.
- 순수 조회의 무기록 동작과 동기 pointer API를 유지합니다. 일반 게시 작업이
  시작되면 남은 정리 효과를 중단하며 새 사용자 승인 절차를 추가하지 않습니다.
- 격리된 저장소에서 replacement pack을 제한·검증하고, 유효한 unindexed pack은
  새 명시적 정리에서만 다시 조사합니다. 불명 소유자·손상·부분 결과와 불완전한
  보존 근거는 그대로 표시하고 남은 후보를 보존합니다.
- pack 읽기 경합과 Windows scratch 경로를 수정하고, ref lock을 검증된 Project·
  attempt·host·runtime 프로세스 시작 신원에 결합합니다.
- 고정 v8의 GC 회귀 84건과 독립 Windows 합성 저장소·CLI 검수를 통과했습니다.
  마켓플레이스 게시와 Host 로딩은 별도 결과로 확인합니다.

## 0.3.0-beta.66 — 게시 여부는 별도 추적

- 고정 Git revision의 World 근거를 불변 스냅샷과 도메인별 freshness, 정확한
  시간 계보로 유지합니다. 기본 저장 방식은 기존 전체 gzip을 유지합니다.
- 이동 후보 비교 비용을 제한하고 Core·CLI·MCP에서 정확한 경로 범위와 페이지
  조회를 제공합니다. 부분 coverage를 의미적 충분성으로 해석하지 않습니다.
- 완료·취소 Todo 상세와 미완료 집계를 분리하며 분기 충돌, unknown coverage와
  기존 대화 진입·startup 동작을 유지합니다.
- 모든 배포 깊이에서 실제 `.lode` 디렉터리를 제외합니다. 로컬 기록은 보존하고
  지원 코드·문서의 `.lode` 문자열이나 이름이 비슷한 일반 파일은 유지합니다.
- 이번 중간 베타에는 태그·GitHub Release를 만들지 않습니다. 마켓플레이스 게시,
  디스크 설치와 현재 Host 로딩은 각각 확인합니다.

## 0.3.0-beta.65 — 게시 결과는 별도 확인

- 동일한 Feature를 구조·기록된 작업·변경 및 관련 영향 관점으로 탐색합니다. 큰
  근거 목록을 페이지로 읽으면서 선택·고정 위치·카메라·독립 읽기 카드·정확한
  소스 비교 상태를 유지합니다.
- 접힌 카드에서도 과거 상태·취소·불확실성·Todo의 부분 및 누락 범위를 보여줍니다.
  낯선 현재성 문자열도 원문대로 남기며, 화면 그룹이 인과·승인·현재 권한을
  만들지 않습니다.
- Product·World·검토된 코드 매핑·작업 인용을 정확한 소스 식별자로 연결합니다.
  심볼만 매핑된 경우 선언 파일의 리비전을 따르되 파일 전체의 기능 구현으로
  해석하지 않습니다.
- 요청 안에서 검증한 원본 바이트와 digest를 읽기 경로 사이에서 재사용하고
  소유권·현재성·무결성 검사는 유지합니다. 정적 MCP 계약 메타데이터를 실행
  조정 코드와 분리하되 공개 동작은 바꾸지 않습니다.
- 관련 합성 테스트와 독립 실제 브라우저 검수로 로컬 구현을 검증했습니다.
  프로젝트 전체 속도·실제 Host/모델·설치·게시는 별도 검증 범위이며,
  중간 릴리스 태그를 만들었다는 의미는 아닙니다.

## 0.3.0-beta.64 — 게시 결과는 별도 확인

- 정확한 원문 참조와 제한된 발췌로 작업 이유·결과·남은 일을 복구합니다. 현재
  방향·취소·불확실성을 과거 근거와 구분하며, 일반 진입에 저장을 요구하지 않습니다.
- 전체 목록 스캔 없이 정확한 그래프·과거 기록 조회를 이어갑니다. 선택적 원시
  아티팩트 목록에는 바이트·항목 한도와 확인 범위를 표시하며, 탐색이 근거를
  승인이나 복구 방향으로 승격하지 않습니다.
- 최소 진입 지침을 재사용하고 사용자 설치 파일을 보존합니다. 검증된 호출 출처가
  있는 지원 Claude/OpenCode 자식의 상태 쓰기만 기본 보호하며, 명시적 정책 설정과
  일반 직접 작업의 기존 의미는 유지합니다.
- 정확한 프로세스 증거에 따른 Claude clear 연속성과 요청별 패키지 MCP 구성을
  추가합니다. 증거가 없으면 일반 명시 복구·프로젝트 설정을 계속 사용할 수 있고,
  소유한 설치 MCP launcher는 검증된 업데이트·롤백 포인터를 따릅니다.
- 일반 native 복구와 선택적 관리형 컴팩션을 구분합니다. 종속 맥락이 필요할 때만
  기존 Session 탐색을 안내하며, 현재 공통 방향의 원문 확대를 우선합니다.
- 로컬 합성 소비 경로와 독립 소스 검증을 실제 설치 Host·모델 동작, CI, 게시,
  로컬 재로드와 구분합니다. beta.63 게시물은 보존하고 중간 릴리스 태그를
  소급 생성하지 않습니다.

## 0.3.0-beta.63 — 게시 결과는 별도 확인

- 변경 경로와 관계없이 main 대상 모든 PR에서 기존 검사를 실행합니다.
  push 필터·필수 검사·권한·게시 조건은 유지하며 런타임 동작은 바뀌지 않습니다.
- 게시 무결성 검증에 workflow recipe가 포함되므로 새 베타 버전을 사용합니다.
  기존 beta.62 패키지와 게시 보호는 유지합니다. 마켓플레이스 게시와 로컬 설치는
  별도로 검증하며 이 기록이 게시 완료를 뜻하지는 않습니다.

## 0.3.0-beta.62 — 게시 결과는 별도 확인

- 정확한 원문 참조로 선택한 Session의 작업과 Todo 맥락을 복구합니다. Run을
  요구하거나 작업 근거를 방향으로 승격하지 않고 과거 분기·상충하는 관측·불확실성과
  현재 취소 지시를 보존합니다.
- 한 읽기 요청 안에서 원문 파일 바이트를 재사용하고 최근 작업을 제한된 범위에서
  탐색합니다. 참조 digest·Project 소유권·현재성 검사를 유지하며 원문 결손이나
  변경을 그대로 표시합니다.
- CLI·MCP·Graph Explorer에서 작업과 Todo 필드를 간결하게 보여 줍니다.
  본문 반복을 줄이면서 정확한 소스 펼치기와 부분 조회 범위를 유지합니다.
- 새 온보딩·정책 Product 리비전을 SessionWork에서 직접 인용할 수 있습니다.
  리비전 종류별로 검증하고 내용이 같은 모델도 Project별로 구분합니다. 소유자가
  없는 과거 원본과 재시도는 보존하며 직접 인용을 위해 소유권을 추정하지 않습니다.
- 독립 소스 검토와 관련 합성 소비 경로 검사로 변경을 검증했습니다. 실제
  Host·모델·GUI 동작, 마켓플레이스 게시와 로컬 설치는 별도 검증 범위이며,
  이 항목이 릴리스 태그를 뜻하지는 않습니다.

## 0.3.0-beta.61 — 게시 결과는 별도 확인

- 선택적 프롬프트 참조 저장소에 Windows 소유자/SYSTEM 전용 DACL과 공통으로
  제한된 헬퍼 실행 예산을 적용합니다. 마스킹·Project 격리·POSIX 권한을 보존하고,
  선택적 캡처가 불가능해도 일반 작업을 막지 않습니다.
- 자식 쓰기 가드는 기본 비활성으로 유지하고, 활성화한 경우 정확한 호출에
  적용합니다. 설치된 Claude 패키지를 정확히 선택하며 native 바인딩이 없다고
  기본 Session으로 암묵적으로 보내지 않습니다. 이식 가능한 OpenCode 설정은
  변경하지 않고 명시적인 논리 Session 라우팅은 계속 허용합니다.
- Graph Explorer 카드에 지원되는 작업 관측·후속 제안·정확한 부분 원문을
  표시합니다. 정확한 계보 endpoint와 소스 비교, 파일·변경 구간 이동을 보존하고
  원문 결손이나 예산 소진을 있는 그대로 알립니다.
- 협력적 배치와 탐색한 근거의 기존 Canvas 개요로 큰 지도에 대응합니다.
  내보낸 전체 레코드·관계, 검색·핀·명시적인 카드 Focus를 보존하며 그래프
  소속을 만들어 내지 않습니다.
- 범위를 한정한 변경을 독립 소스·브라우저 검토와 관련 합성 검사로 검증했습니다.
  오래된 전체 SVG assertion을 고치고 종료 단계 경계는 제어된 시계로 검증하되
  런타임 유예 시간은 바꾸지 않았습니다. 실제 Host/provider 동작, Claude
  `/clear`, 다른 PC의 카드 원인과 실프로젝트 성능은 미검증입니다. 마켓플레이스
  게시와 로컬 설치는 여전히 별도 확인하며 이 항목이 릴리스 태그를 뜻하지 않습니다.

## 0.3.0-beta.60 — 게시 결과는 별도 확인

- Graph Explorer 지도를 제목 중심으로 바꾸고 카드별 상세와 독립적으로 접힌
  읽기 카드를 제공합니다. 사용자가 펼친 상태·스크롤·선택·카메라·핀을 보존하고,
  그래프 전체를 재정렬하지 않고 변경된 카드의 실제 크기를 측정합니다.
- 근거가 있는 직접 소속만 그룹으로 보여 주며 소속이나 간선을 만들지 않습니다.
  원본의 현재성·원문 결손·기록된 조건과 알 수 없는 상태는 펼쳐서 확인합니다.
- Source 계층의 import/call에서 경로와 digest가 일치하는 기존 정확한 소스
  비교로 연결합니다. 코드 맥락을 명시적으로 열고 추가·삭제 행, 파일·변경 구간
  이동과 현재 없는 경로·rename의 보수적인 설명을 유지합니다.
- 실제 reader가 만든 합성 자료로 요청한 UI를 localhost 브라우저에서 검수하고
  관련 소스 테스트를 수행했습니다. 실제 Host 사용·대규모 그래프의 브라우저
  성능·200% 글자 확대·긴 본문 스크롤 전체를 입증하지는 않습니다.
  소스·PR 준비 완료가 마켓플레이스 게시나 로컬 설치를 뜻하지는 않습니다.

## 0.3.0-beta.59 — 게시 결과는 별도 확인

- Claude Code, Codex, OpenCode MCP 실행 줄을 이식 가능한 형태로 기록합니다.
  공유 `.mcp.json`과 `opencode.json`은 `node`와 프로젝트 상대 스크립트 또는
  클라이언트 placeholder(`${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`,
  `{env:LODE_PLUGIN_ROOT}`)를 사용합니다. 절대 Node·설치 경로는 그 파일에
  두지 않습니다. 추적 파일과 세 클라이언트 초기화 결과를 구체적인 개인 홈
  경로에 대해 검사하고, 마켓플레이스 음성 픽스처만 허용 목록에 둡니다.
  개인 Windows LSP 픽스처 경로를 바꿨습니다. 기본 graph-explorer HTML은
  로컬 보고서이며 `--share`는 생성된 기계 경로를 계속 뺍니다.
- 선택적 MCP 서브에이전트 상태 쓰기 가드를 추가합니다.
  `LODE_SUBAGENT_WRITE_GUARD=enforce`가 아니면 꺼져 있습니다. 강제하면
  서브에이전트 caller의 비읽기 전용 Lode 도구를 `SUBAGENT_STATE_WRITE_REJECTED`로
  거절합니다. Claude는 기존 child `agent_id`, Codex는 `_meta.agent_id`,
  `_meta.subagent` 또는 `SubagentStart` 관측, OpenCode는 자식 세션
  `parentID`를 정확한 호출 직전 hook에서 확인합니다. OpenCode도 같은 도구의
  read-only hint와 공통 정책을 적용하며 호출 사이에 공유하는 티켓은 만들지 않습니다.
  기본값은 꺼짐이라 서브에이전트가 canon과 checkpoint를 계속 기록할 수 있습니다.
- 압축 또는 clear 뒤에 제한되고 가려진 로컬 사용자 prompt 참조를 복원합니다.
  Claude Code와 Codex는 `UserPromptSubmit`의 `prompt`를 저장하고
  `PreCompact`에서 고정한 뒤, 여유가 있으면 `SessionStart`의 `compact` 또는
  `clear`에 덧붙입니다. OpenCode는 `message.part.updated`를 저장하고
  `experimental.session.compacting`에서 고정한 뒤, `session.compacted` 또는
  `clear` `command.executed` 이벤트 다음 system transform에 한 번 덧붙입니다.
  검증된 Project 신원과 caller로 참조를 격리하여 명시적인 동일 Project 이동을
  유지하고 다른 Project에는 전달하지 않습니다. 텍스트에는 권한이 없습니다.
  checkpoint가 복구 원천으로 남습니다.
- OpenCode가 환경변수를 빈 값으로 치환한 경로는 현재 패키지와 연결된 관리 원본의
  hash·소유권을 확인한 경우에만 메모리에서 복구합니다. 사용자 소유·수정·무관한
  명령은 보존합니다. 합성 배포 업그레이드·롤백 검증은 releaseId 문자열 대신
  실제 선택된 설치 경로를 확인합니다.
- 이 소스 기록은 게시 증거가 아닙니다. 이 베타에는 중간 태그나 GitHub
  Release를 만들지 않습니다.

## 0.3.0-beta.58 — 게시 결과는 별도 확인

- 좁은 화면에서 선택 도구를 접고 실제 측정한 노드·라벨 크기로 화면을 맞춥니다.
  선택 동작·고정 위치·그래프 권한 경계는 유지합니다.
- 그래프 질의에서 정확한 선언 식별자를 우선하되 일반 단어를 의미 판정으로
  해석하거나 문서를 제외하지 않습니다. 요청 내 조회를 재사용하며 freshness·무결성
  검증을 유지합니다. 유의미한 속도 개선은 측정되지 않았습니다.
- 현재 파일이 없으면 정확히 인용된 과거 원문을 표시합니다. 범위와 바이트를 검증한
  과거 이름 변경 후보만 안내하며 동일성·인과·현재 대체 경로를 추정하지 않습니다.
  UTF-8 BOM도 근거에 보존합니다.
- 남은 CLI 표시 문구를 정리하고 한·영 보안 및 기여 안내를 배포 패키지에 포함합니다.
- 중복 저장 테스트 파일과 구버전 fixture 준비를 통합하고 고정 응답용 하위 프로세스를
  줄입니다. 실제 프로세스 동작과 종료 검증은 유지합니다.
- GitHub 비공개 취약점 신고를 활성화하고 한·영 보안 문서에 신고 링크를 넣습니다.
  대응 SLA나 보안 지원 기간을 약속하지는 않습니다.
- 실제 브라우저 GUI 수용과 보고된 7.3초 질의는 아직 확인되지 않았습니다.
  로컬·합성 검사가 GUI·Host 로딩·provider 동작을 입증하지 않습니다.

이 소스 기록은 게시 증거가 아닙니다. 정확한 소스 커밋의 CI와 정식·호환 마켓플레이스
marker를 각각 확인해야 합니다. 중간 태그/GitHub Release, 로컬 설치, MCP 재로드는
포함하지 않습니다.

## 0.3.0-beta.57 — Codex·Claude 마켓플레이스 게시 확인

소스: `e77c8e84ba82bbc70764110087d8485b2dbd7973`.
CI [39610882032](https://github.com/binary1215/lode/actions/runs/39610882032)가
성공했고, 정식·호환 Codex·Claude 마켓플레이스 브랜치를 이 소스와 대조했습니다.
위 게시 정책에 따라 이 중간 베타에는 GitHub Release나 태그를 만들지 않았습니다.
이 기록은 게시 증거이며 특정 Host의 패키지 재로드를 입증하지는 않습니다.

- 잘못된 transport 요청이 자동 종료를 시작하기 전에 기존 테스트 정리 시계 제어를
  적용합니다. 모든 이름 있는 반례와 정확한 네이티브 종료·트리 정리·PID 부재 검증을
  유지합니다. 제품 종료 유예 시간을 바꾸거나 불확실한 정리를 성공으로 바꾸지 않습니다.
- beta.56의 그래프 다중 선택 UX를 이어받습니다. 실제 브라우저 GUI 수용은 아직
  미검증이며 CI 성공만으로 GUI나 Host 재로드를 입증하지 않습니다.

## 0.3.0-beta.56 — 미게시

소스: `be9bcacae377babe3aa425172661b5b9d9820847`.
CI [39602422243](https://github.com/binary1215/lode/actions/runs/39602422243)에서
잘못된 transport 정리 테스트 2개가 실패해 마켓플레이스 게시를 건너뛰었습니다.
원래 실패는 beta.57 수정 결과와 구분해 보존합니다.

- 선택한 여러 기록과 정확히 연결된 파일 비교를 함께 열어 둡니다.
- 읽기 초점·노출 범위·카메라를 분리하고 사각형 선택, 반복 경계 확장,
  마지막 추가분 접기와 실제 화면 이력을 제공합니다.
- 성분별 참조를 고정하고 동률 최단 선행 가지와 원래 방향을 모두 강조합니다.
  연결을 인과로 추정하지 않습니다.
- 큰 선택도 페이지와 취소 가능한 계산으로 탐색합니다. 로컬 읽기 전용
  표현 변경이며 새 권한이나 게이트를 추가하지 않습니다.
- 합성 UI 회귀 검사는 실제 브라우저·GUI 수용 검증이 아닙니다.

## 0.3.0-beta.55 — 게시 완료

소스: `fe731c88183f021e05c9a1a6e8bb7ac34890cd9c`.
CI [39581040674](https://github.com/binary1215/lode/actions/runs/39581040674)가
성공했고 Lode 및 호환 Codex·Claude 마켓플레이스 브랜치를 검증했습니다.

- 검색 중 선택 문맥을 유지하며 명시적인 근거 범위는 보존합니다.
- 복사되거나 위치 게시가 중단된 Project를 상태 조회에서 설명하되 채택하지 않습니다.
- `graph-explorer --share`로 자동 생성 로컬 메타데이터만 제외합니다. 원문을 유지하며
  HTML 크기를 정확히 안내하고 크기 게이트는 추가하지 않습니다.
- 이동·CLI 안내, 사용자에게 보이는 Lode 명칭, 소스 경로 부재 설명을 수정합니다.
  새 MCP 도구나 복구 권한을 추가하지 않습니다.

## 0.3.0-beta.54 — 게시 완료

소스: `d0c12fe20ad0759efedb096542ecd7ccf47af2a3`.
CI [39562855184](https://github.com/binary1215/lode/actions/runs/39562855184)가
성공했고 Lode 및 호환 Codex·Claude 마켓플레이스 브랜치를 검증했습니다.
즉시 반환되는 Session 선택 손실 진단을 보존하고 명시적 이동 회귀 fixture를
지원되는 재개 동작에 맞췄습니다.

## 0.3.0-beta.53 — 미게시

소스: `22d471e18e0ebbe82b8ea07612cc749598ae20c4`.
확장 가능한 그래프 탐색·정확한 문맥 상세·명시적 Project 폴더 이동을 추가했습니다.
CI 회귀 테스트 2개가 실패해 마켓플레이스 게시를 건너뛰었습니다. 수정 후속 버전은
beta.54이며 이 과거 소스를 덮어쓰지 않습니다.

## 0.3.0-beta.52

소스: `4883322`. 공유 그래프 화면에서 기록된 문맥 출처를 보존했습니다.

## 0.3.0-beta.51 — 미게시

소스: `465120c`. 그래프 표시와 스캔 서명을 맞췄지만 CI가 실패했습니다.
마켓플레이스 게시 성공 버전으로 해석하지 마세요.

## 0.3.0-beta.50 / beta.49

소스: `3327dfc` / `a2a9b08`. 각각 계산 출력의 512 MiB까지 재시도와 기본
출력 예산 64 MiB 상향을 추가했습니다. 이 항목은 소스 변경 기록이며 별도로
게시 상태를 확인했다는 뜻은 아닙니다.

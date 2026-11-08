# 용어집

> [영문 원문](../glossary.md)

[한국어](glossary.md)

Lode가 도구 결과, Skill, 이 문서들에서 쓰는 용어의 짧은 정의입니다. 각 항목은
전체 정의가 있는 문서로 연결됩니다.

| 용어 | 정의 | 정의된 곳 |
| --- | --- | --- |
| Project | 저장소의 Lode 상태를 담는 하나의 정본 기록으로, `.lode/` 폴더(이전 Project는 `.head/`)에 저장됩니다. 공통 사용자 방향과 논리 Session을 소유하며 공급자, Host, 대화가 바뀌어도 같습니다. | [헌법](lode-constitution.md), [이식성](project-portability.md) |
| Session | 논리 Lode Session: Project 안에서 독립적으로 라우팅되는 하나의 작업 흐름으로 자기 목적, 진행, 복구를 가집니다. 공급자 대화가 아니며, 요청은 `session_id` 또는 `--session`으로 선택합니다. | [그래프 탐색과 Session](graph-discovery.md), [Session 복원](session-recovery.md) |
| P2 direction | P2(정본 복구) 기록으로 보관되는 사용자의 현재 방향: 공통 Project 방향과 선택된 Session의 목적, 제약, 취소입니다. 증거, 요약, 과거 승인은 이를 다시 쓸 수 없고, 나중의 취소가 항상 적용됩니다. | [권한 평면](authority-plane-contract.md), [Session 복원](session-recovery.md) |
| Run | 실행 계약, ResultPacket, Fresh Lode 검토를 갖는 관리 실행의 지속 단위입니다. 소유권, 중단 후 복구, 불확실한 효과를 추적해야 할 때만 쓰며 일반 작업에는 필요 없습니다. | [실행 계보](execution-lineage.md) |
| Capsule | ContextCapsule: 하나의 정확한 작업을 위해 선택한 맥락을 재현 가능하게 내용 주소로 묶은 것입니다. 선택 맥락 인계, 지속 Run, 복구에만 준비하고 기본은 파일을 직접 읽는 것입니다. | [Context Compiler](context-compiler.md) |
| Canon | Product Canon: 승인된 제품 의미와 정책(P1)입니다. 정확한 현재 후보에 대한 명시적 사용자 ReviewDecision으로만 바뀌며, 그래프, 결과, 메시지는 스스로 승격되지 않습니다. | [Product Model](product-model.md), [권한 평면](authority-plane-contract.md) |
| World | Repository World Model: 저장소에서 파생한 코드 구조(파일, 심볼, import, 호출)의 재구성 가능한 뷰입니다. 맥락과 영향 조회의 증거이지 정본이나 지시 권한이 아닙니다. | [World Model](world-model.md) |
| Product | `profile: "product"`로 활성화하는, 검토된 제품 의미(Feature, Policy, Metric)를 위한 선택적 거버넌스 계층입니다. Core 작업, 그래프 탐색, 복구는 이것 없이 동작합니다. | [Product Model](product-model.md), [온보딩](onboarding.md) |
| Host | 대화를 실행하는 클라이언트: Claude Code, Codex, OpenCode입니다. 네이티브 세션 식별, 훅, 위임을 제공하지만 Host의 성공이나 가용성은 Lode 권한을 주지 않습니다. | [Session 작업 맥락과 Host 연속성](session-work-context.md), [런타임 어댑터](runtime-adapters.md) |
| Checkpoint | SessionRunCheckpoint: checkpoint sync가 쓰는, Session의 현재 위치, 결정, 다음 기대 결과를 담은 P2 기록입니다. 없으면 일반 작업은 그대로 계속됩니다. | [Session 복원](session-recovery.md), [compaction 복구](compaction-recovery.md) |
| Capability | 어댑터나 Host가 제공함을 증명할 수 있는 선택 기능으로, 탐색으로 찾는 도구 묶음 등이 있습니다. 없으면 공개되고 그것에 의존하는 작업만 제한되며, 기능이 있다고 권한이 생기지는 않습니다. | [헌법](lode-constitution.md), [아키텍처](architecture.md) |
| Observation | 외부 출처(테스트, 배포, 릴리스, 지표, 소스 수집)에서 기록한 사실로 P3 증거로 보관됩니다. 판단에 쓰이지만 승인, 복구, 작업 지시를 할 수 없습니다. | [Observation 어댑터](observation-adapters.md) |

이 용어들 뒤의 권한 평면 P1–P5는
[권한 평면 계약](authority-plane-contract.md)에 요약되어 있습니다.

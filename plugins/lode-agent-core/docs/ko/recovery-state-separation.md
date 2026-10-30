# 복구 의미·현재 사실·World 도메인 최신성

[English source](../recovery-state-separation.md)

일반 복구는 과거 checkpoint의 의미와 선택 Session의 현재 Run/검토 사실,
최신 공통 ProjectDirection을 함께 읽습니다. 현재 포인터가 checkpoint 작성 당시와
같아야 하지는 않습니다. `SessionRestoreProjection` 0.2는 원본을 보존하고
`currentExecution`을 별도로 제공합니다. 옛 위치·다음 결과는
`consumerInstruction.historicalCheckpointContext`에 표시하며 현재 지시로 재발행하지
않습니다. 현재 다음 행동은 Lode가 판단하고 과거 승인은 새 효과 권한이 아닙니다.
P4 투영 버전은 불변 P3 통합 프로토콜을 바꾸지 않습니다. 기존 0.1 통합 요청·영수증의
검증 조건과 원본 바이트는 그대로 유지됩니다.
진입은 읽기 전용이며 checkpoint 부재는 일반 작업 gate가 아닙니다. 기존 선택적
basis/sync는 의미를 새로 보존할 실제 필요에 사용하지, Run마다 정합화하는 의례가
아닙니다. one-shot compaction의 exact epoch/checkpoint/Run/Session/사용자 turn/
미소비 token 검사는 유지됩니다.

## 저장과 실행 재시도 구분

`run-start --contract <id> [--start-request <key>]`와 typed MCP
`lode_run_start`는 같은 Core 전환입니다. Lode/Host가 내부 키를 한 번 정해 동일
요청 재시도에 유지합니다. 사용자 ID 입력이나 prepare 호출은 필요 없습니다.
정체성은 기존 Run에 보존하며 새 global ledger는 없습니다. 같은 키/다른 입력은
충돌, 같은 contract/다른 키는 새 요청입니다. 키 없는 정상 시작도 유지하지만
불확실한 전달을 최신 Run·contract만으로 같은 요청이라 추측하지 않습니다.

Run/Result/Decision/Session은 중단 복구 가능한 다중 파일 저장이지 전원 손실까지
원자적이지 않습니다. 관련 mutation에서 기존 exact artifact/preimage로 누락
Session 쓰기만 완료합니다. 누락 결과·판정은 창작하지 않고 조회는 저장을 수습하지
않습니다. 과거 start 재응답은 `run_start_already_committed`와
`executionReplayAllowed: false`이며 이전 Run 재활성화나 worker/provider 실행을
유발하지 않습니다. 실제 실행에는 현재 lease/권한 검사가 유지됩니다.
`canonicalCommit: committed`는 저장 완료이지 작업 성공·검토 accept가 아닙니다.
`projectionUpdate`로 index 미반영을 따로 표시하며 끝난 원본 전환을 재실행하지
않습니다. 불명 외부 효과는 기존 소유/lease 근거 확인 전 재실행하지 않습니다.

## 논리 Session 선택

명시 `session_id`/`--session`, 의도적 공유, legacy default를 유지합니다. embedding
Host는 caller별 branded `createSessionCallContext` 또는 요청별 resolver를 주입할
수 있습니다. P5이며 공급자 ID를 Canon에 넣거나 공용 프로세스에 마지막 선택
하나를 저장하지 않습니다. 알려진 선택 유실은 Session-dependent 조회/변경만
unresolved로 표시하고 공통 방향·독립 그래프/코드 조회는 계속합니다. 명시·검증된
선택으로 해당 caller만 복원합니다.
선택적 Host resolver가 실패해도 검증된 명시 Session은 현재 요청을 처리합니다.
MCP `_meta.headSessionBinding`은 후속 binding 보존이 불가능함을 표시하며 다음 호출의
선택까지 성공했다고 주장하지 않습니다. 명시 선택이나 검증된 binding이 없는 의존 호출은
계속 unresolved입니다. CLI 정보·확인된 Project 독립 조회는 MCP와 같은 독립 경계를 쓰며,
선택 Session을 표시하는 조회(Product 운영 status 포함)는 binding이 필요합니다.

선택이 유실되거나 Host 연결을 확인할 수 없을 때 기존 진입·상태 조회(CLI
`conversation-enter`, `status`, `doctor`)는 Project-only 부분 정보를 제공합니다.
검증된 identity와 최신 공통 방향·제약·취소를 읽되 `availability`로 Session/Run/복구는
unavailable, 조사하지 않은 진단은 not assessed로 구분합니다. 준비 완료·drift 0·복구
성공을 추정하지 않습니다. 이 분기는 기본 Session을 대신 읽거나 Session 열거,
World/DB 진단, 상태 쓰기를 하지 않습니다. 방향 부재는 `null`이며 손상·다른 Project의
원본은 오류로 남습니다. CLI는 `session-restore`를 포함해 성공 formatter 전에 unresolved를
처리합니다. init/resume·restore·Run·compaction의 기존 Session/효과 경계는 유지합니다.
Lode는 독립 작업을 계속하고 의존 작업에만 기존 검증된 explicit/Host 선택을 사용합니다.
새 selector·사용자 ID 양식·복구 호출 체인·승인 단계는 없습니다. MCP 미해결 응답은
기존 JSON text와 structuredContent를 유지하고 정상 응답의 도구별 표현도 바꾸지 않습니다.
fixture 검증은 실제 모델의 질문 감소나 설치 Host의 지속 연결을 실측한 증거가 아닙니다.

지원되는 Codex native MCP 요청은 실제 caller metadata를 제공하며 Claude Code의
번들 same-instance Hook은 root/child 요청을 구분합니다. 기존 init/resume 흐름이 검증한
선택을 P5에 보존하면 읽기 전용 SessionStart가 그 연결을 조회합니다. 선택적 연결 보존의
실패가 원래 Core 결과를 없애거나 재실행을 허가하지 않습니다. legacy transport의
명시/default 동작은 유지됩니다. OpenCode는 trusted Host 연결 지점만 제공하며 native
Hook 통합을 주장하지 않습니다. 이 구현과 합성 protocol 시험은 설치 GUI·실제 모델/
계정·실제 compaction 성공의 증거가 아닙니다.
[Host 지원 범위와 한계](session-work-context.md#식별자-추정-없는-host-지원)를 참고하세요.

## World 도메인

전체 World digest에서 runtime을 삭제하지 않습니다. World 0.19는 기존 snapshot에
분석·도메인 basis를 보존하며 과거 원본은 migration 없이 검증해 읽습니다.
코드/Product/Git/관측/captured runtime 최신성을 구분하고 runtime은 원래 Session
owner를 유지합니다. 현재 선택 Session 사실은 별도로 읽습니다. 코드 조회는 파일
집합·digest·scope·분석 기준을 확인하고 무관한 Product/runtime reader를 먼저
실행하지 않습니다. Run/checkpoint 변화만으로 IMPORTS/CALLS를 막지 않되 실제
코드·scope·analyzer 변화는 탐지합니다. 구 snapshot의 분석 기준을 입증하지 못하면
unknown과 원본 fallback이지 강제 refresh/upgrade gate가 아닙니다.

혼합 traversal은 확장 전에 관련 node/edge를 걸러 원본 GraphSnapshot ID/hash와
제외 범위를 유지합니다. adapter가 mask를 지원하지 않으면 embedded 조회로
fallback하고 원격 쓰기를 하지 않습니다. Context도 전체 stale 때문에 코드 전체를
버리지 않고 검증한 도메인을 포함합니다. 필요한 기존 refresh는 Lode의 허용된
유지 작업이지 사용자 수동 절차·매 턴 전량 refresh 의무가 아닙니다.
deterministic trace는 호출·저장·instruction·fallback을 확인하는 증거이지 실제
모델 질문 횟수·체감 UX·시간·토큰·비용을 실측했다는 뜻은 아닙니다.

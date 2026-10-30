> 이 문서는 [role-coordination.md](../role-coordination.md)의 한국어판입니다.

# 일반 Host 위임과 선택적 연결

Lode가 전체 목표를 소유하고 현재 Host의 task·message·progress 기능으로
유용한 bounded outcome을 위임합니다. worker에게 필요한 맥락, 소유권,
제약과 완료 증거를 전달합니다. 일반 위임은 Lode 역할 token, generation,
inbox, target hash chain이나 coordination receipt를 만들지 않습니다.
이는 공유 권한이나 swarm의 투표가 아닙니다.

성공한 기여를 보존하고 미완료 부분만 처리합니다. 교체 전 unknown effect를
검사하고 겹치는 쓰기를 조정합니다. 취소 요청은 process exit의 증거가 아닙니다.
기여가 시작되지 않았거나 미해결 effect가 없으면 직접·순차 작업이 가능합니다.

## 선택적 exact endpoint 연결

`VerifiedWorkspaceHostAdapter`는 기존 endpoint를 위한 좁은 Host composition입니다.
경계는 Project, logical Lode Session, role과 project root를 결속합니다.
현재 Host snapshot이 exact endpoint, canonical CWD와 runtime을 확인합니다.
binding token, generation이나 append-only target chain은 요구하지 않습니다.
Host별 pane, socket, executable과 UI 동작은 Core 밖에 둡니다.

`session-continue`는 선택적 연결 전에 canonical P2 방향을 복원합니다.
endpoint가 사라지면 명시적인 fresh-logical-Lode fallback을 반환합니다.
이는 복구 실패나 새로운 사용자 설정 절차가 아닙니다.
message, provider identity와 Host snapshot은 방향을 쓰거나 결과를 승인하거나
Product Canon을 바꾸지 못합니다.

portable export reference는 프로젝트 외부에 현재 snapshot 하나를 보존합니다.
project/caller/export 설정과 process-ownership proof는 Host environment에서만 받습니다.
이는 attachment bridge이지 worker launcher나 지속 역할 mail service가 아닙니다.
과거 Host coordination file은 수정·삭제하지 않습니다. 폐기된 API는 새 기록을 만들지 않습니다.

## 관리형 작업은 별도

중단 복구·unknown effect·중복 통합 방지가 필요한 지속 결과는 기존 bounded
execution을 사용할 수 있습니다. 각 dispatch와 lease는 독립적입니다.
worker의 운영상 성공은 증거이지 승인이 아닙니다. Lode가 전체 목표를 판단하고
복구 방향을 명시적으로 제공합니다.

source와 local fixture는 exact attachment, endpoint 교체, unavailable fallback과
원본 checkpoint 보존을 검증합니다. 과거 live role-message 증거는 실제 provider에서
새 경량 경로가 작동한다는 증명이 아닙니다. 새 model, 실제 DB 또는 설치 플러그인
E2E를 검증했다고 주장하지 않습니다.
[런타임 어댑터](runtime-adapters.md)와 [Session 복구](session-recovery.md)를 참고하세요.

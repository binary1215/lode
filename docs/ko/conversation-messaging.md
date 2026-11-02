> 이 문서는 [Same-project conversation messaging](../conversation-messaging.md)의 한국어판입니다.

# 같은 프로젝트 대화 메시지

현재 Project에 Host가 등록한 대화를 확인하고, 사용자가 지시한 메시지를 한 주소에 전달합니다. 목록 조회는 읽기 전용입니다. 대화를 발견했다는 사실만으로 연락 권한이 생기지는 않습니다.

## 대화로 사용하기

같은 프로젝트의 다른 대화를 보여 달라고 한 뒤 수신자와 보낼 내용을 말하면 됩니다. provider가 `lode_conversation_list`와 `lode_conversation_send`를 사용하며, 사용자가 ticket이나 JSON을 작성하지 않습니다. 답장은 발신 주소와 `reply_to`를 사용합니다.

| 결과 | 의미 |
| --- | --- |
| `delivered` | 클라이언트의 접수 영수증을 받았습니다. 모델 작업 완료의 증거는 아닙니다. |
| `sent` | 소켓·파이프·Hook의 로컬 인계까지 확인했습니다. 모델이 읽었다는 영수증은 없습니다. |
| `queued` | 아직 전달되지 않았으며 수신자의 다음 프롬프트나 OpenCode watcher를 기다립니다. |
| `unknown` | 이미 인계됐을 수 있습니다. 근거를 보존하고 자동 재전송·재주입하지 않습니다. |
| `refused` | 본문 발신 전 현재 대상·신원·경로 검증이 거절됐습니다. 원래 사유를 유지하고 자동 대기열로 돌리지 않습니다. |
| `unreachable` | 검증된 유효 등록이 없어 메시지 본문을 대기열에 넣지 않았습니다. |

다른 에이전트의 메시지는 증거이며 사용자 권위, ReviewDecision, Product Canon, checkpoint나 현재 취소를 우회할 지시가 아닙니다. 본문은 데이터로 구분합니다. 하위 에이전트는 별도 주소를 쓰며 부모의 우편함을 비우지 못합니다.

## 등록과 조회

Claude/Codex의 정상 SessionStart·UserPromptSubmit Hook, OpenCode의 플러그인 lifecycle에서 초기화된 Project에 등록합니다. 관측 전용 Hook은 없는 우편함을 만들지 않습니다. 이미 실행 중인 클라이언트는 다음 정상 lifecycle 이벤트에서 나타날 수 있습니다. 메시징을 위한 새 승인·bind·save·초기화 의식은 없습니다.

목록 조회는 디렉터리나 키를 만들지 않고, presence 갱신·ticket 소비·보존 기간 정리를 하지 않습니다. 오래되거나 변조돼 검증하지 못한 등록은 안내로 표시할 수 있지만 읽었다고 승격하지 않습니다. 정상 Host 등록이 자신의 운영 투영을 갱신합니다. 로컬 서명 키가 손상됐거나 읽히지 않으면 원문을 보존하고 임의 교체하지 않습니다.

버전이 있는 Host 로컬 서명은 Project/store·주소·runtime·native ID·채널·등록 세대를 묶습니다. 일반 heartbeat는 같은 검증된 신원과 세대의 더 풍부한 채널을 보존합니다. 같은 등록의 heartbeat가 진행 중인 전송을 무효화하지 않으며, 다른 endpoint나 신원은 발신 전과 실제 전송 직전에 다시 확인합니다. 같은 OS 사용자의 키 수정 권한자에 맞서는 원격 인증이라는 뜻은 아닙니다.

물리 경로와 열린 파일 핸들을 대조하며 파일은 바이트 상한 안에서 읽습니다. junction·링크·관측된 디렉터리 교체는 await 이후에도 거부합니다. 임의의 비협조적 파일시스템 writer에 대한 OS sandbox나 원자성 보장은 아닙니다. 이 실패가 일반 Core 작업이나 소스 탐색을 막지는 않습니다.

## Provider 어댑터와 검증 범위

- Claude는 관측된 inbox 소켓·named pipe를 씁니다. Windows는 확인된 peer token 없이는 쓰지 않으며, 토큰을 Project 기록에 복사하거나 로그에 출력하지 않습니다. 쓰기 성공은 `sent`입니다. 연결·쓰기 전 실패만 대기시킬 수 있고, 쓰기 시작 후 오류·deadline은 `unknown`입니다. 기본 연결·쓰기 제한은 3초입니다.
- Codex 즉시 전달은 shared-engine 등록이 있을 때만 사용합니다. 기존의 검증된 Go supervisor가 유한한 proxy 프로세스 트리를 소유하며 raw PID/taskkill 정리를 사용하지 않습니다. 정확한 등록 thread를 초기화·resume하고 sandbox·승인 정책을 덮어쓰지 않고 turn을 요청합니다. turn ID가 오면 `delivered`, turn/start 이후 확인이 사라지면 `unknown`입니다. 메시지 turn을 보내지 않은 startup·전송 전 실패만 대기시킵니다. RPC 기본 대기는 각각 3초이며 supervisor 수명과 종료 정리도 제한됩니다. Codex Desktop 즉시 전달은 미구현이며 다음 정상 프롬프트가 fallback입니다.
- OpenCode는 우선 대기시키고 플러그인 watcher가 prompt합니다. 메시지 ID가 오면 `delivered`입니다. prompt 호출 이후 오류·timeout·영수증 부재는 `unknown`이며 다시 prompt하지 않습니다. 기본 대기는 30초입니다. 공유 Host 클라이언트를 종료하거나 늦게 완료되는 SDK 요청이 취소됐다고 주장하지 않습니다. v2의 queue형 prompt 인터페이스는 배포된 OpenCode 바이너리에서 아직 검증하지 않았습니다.

Core·MCP·Hook과 프로토콜 실패는 합성 fixture로 검사하며, 실제 Go supervisor가 합성 proxy를 소유하는 검사도 포함합니다. 세 설치 클라이언트 전체의 실사용, 계정 연결이나 실제 모델 이어쓰기 검증을 뜻하지 않습니다. Native-history 이관은 별도의 고정 Codex 버전 메타데이터 기능입니다.

## 발신 ticket과 저장

필요한 경우 OpenCode의 before-tool Hook이 짧은 수명의 caller ticket을 자동 공급합니다. 목록은 서명을 읽기만 하며 소비하지 않습니다. 발신은 메시지 접수 전 단일 배타 소비 표식을 만들어 동시 사용 중 하나만 허용합니다. 소비 실패는 발신하지 않습니다. 소비 후 중단·응답 유실은 ticket 재사용이나 새 ticket 자동 재서명으로 반복하지 않고 원래 결과의 불확실성을 표시합니다. 키는 HOME/USERPROFILE과 정확한 Project root로 정해지는 Host 비공개 상태이며 운영 상태 root 차이에 의존하지 않습니다.

`.lode/messaging/` 또는 선택된 legacy store의 같은 디렉터리는 폐기 가능한 Host 조정 자료입니다. Project·Session 복구 상태가 아니며, 복사·내보내기로 살아있는 우편함·ticket·프로세스 소유권·endpoint binding을 옮기지 않습니다. 기간 정리는 변경이 있는 등록·발신 lifecycle에서만 수행합니다. 사용자 ignore·추적 중인 중첩 marker·Git/index 상태 불명은 보존합니다. beta75 이전의 정확한 generated ignore 원문은 새 messaging 규칙과 독립적으로 인식하며, retained snapshot은 여전히 보존할 이력입니다.

기존의 수신자별 200개 메시지·1 MiB 용량과 24시간 보존 기간을 유지합니다. 한 수신자가 가득 차도 다른 수신자는 막지 않습니다. 미전달 대기열의 만료는 제한된 안내를 만들 수 있지만, 결과 불명 인계를 확정 미전달로 설명하거나 재주입하지 않습니다. 목록은 최대 256개와 누락 수를 표시합니다. 운영 자원 범위이며 의미적 충분성이나 권한 판정이 아닙니다.

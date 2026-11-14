> 이 문서는 [Same-project conversation messaging](../conversation-messaging.md)의 한국어판입니다.

# 같은 프로젝트 대화 메시지

현재 Project에 Host가 등록한 대화를 확인하고, 사용자가 지시한 메시지를 한 주소에 전달합니다. 목록 조회는 읽기 전용입니다. 대화를 발견했다는 사실만으로 연락 권한이 생기지는 않습니다.

## 대화로 사용하기

같은 프로젝트의 다른 대화를 보여 달라고 한 뒤 수신자와 보낼 내용을 말하면 됩니다. provider가 `lode_conversation_list`와 `lode_conversation_send`를 사용하며, 사용자가 ticket이나 JSON을 작성하지 않습니다. 답장은 발신 주소와 `reply_to`를 사용합니다.

| 결과 | 의미 |
| --- | --- |
| `delivered` | 클라이언트의 접수 영수증을 받았습니다. 모델 작업 완료의 증거는 아닙니다. |
| `sent` | 소켓·파이프·Hook의 로컬 인계까지 확인했습니다. 모델이 읽었다는 영수증은 없습니다. |
| `queued` | 아직 전달되지 않았습니다. 수신자의 턴이 끝날 때, 살아 있는 채널을 찾은 이후 발신, 다음 프롬프트, OpenCode watcher 중 하나로 전달됩니다. 아래 "대기 중인 메일 전달"을 보세요. |
| `unknown` | 이미 인계됐을 수 있습니다. 근거를 보존하고 자동 재전송·재주입하지 않습니다. |
| `refused` | 본문 발신 전 현재 대상·신원·경로 검증이 거절됐습니다. 원래 사유를 유지하고 자동 대기열로 돌리지 않습니다. |
| `unreachable` | 검증된 유효 등록이 없어 메시지 본문을 대기열에 넣지 않았습니다. |

다른 에이전트의 메시지는 증거이며 사용자 권위, ReviewDecision, Product Canon, checkpoint나 현재 취소를 우회할 지시가 아닙니다. 본문은 데이터로 구분합니다. 하위 에이전트는 별도 주소를 쓰며 부모의 우편함을 비우지 못합니다.

## 등록과 조회

Claude/Codex의 SessionStart 중 source가 `startup`이나 `resume`인 경우 초기화된 Project를 Host 전용 registry에 등록합니다. 그래서 resume한 세션은 지금 실행 중인 프로세스의 채널을 기록합니다. OpenCode는 플러그인 lifecycle로 등록합니다. SessionStart `clear`·`compact`는 같은 프로세스를 이어 가므로 등록하지 않습니다. SessionStart `fork`도 등록하지 않으므로, fork한 세션은 직접 메시지를 보내기 전까지 목록에 나오지 않고 보내면 다음 프롬프트 수신으로 등록됩니다. 관측 전용 Hook(UserPromptSubmit·Stop·PreCompact 등)은 등록하지 않습니다. 등록·key 잠금이 사용 중이면 기다리지 않습니다. 메시징을 위한 새 승인·bind·save·초기화 의식은 없습니다.

목록 조회는 디렉터리나 키를 만들지 않고, presence 갱신·ticket 소비·보존 기간 정리를 하지 않습니다. 오래되거나 변조돼 검증하지 못한 등록은 안내로 표시할 수 있지만 읽었다고 승격하지 않습니다. 정상 Host 등록이 자신의 운영 투영을 갱신합니다. 로컬 서명 키가 손상됐거나 읽히지 않으면 원문을 보존하고 임의 교체하지 않습니다.

버전이 있는 Host 로컬 서명은 Project/store·주소·runtime·native ID·채널·등록 세대를 묶습니다. 일반 heartbeat는 같은 검증된 신원과 세대의 더 풍부한 채널을 보존합니다. 같은 등록의 heartbeat가 진행 중인 전송을 무효화하지 않으며, 다른 endpoint나 신원은 발신 전과 실제 전송 직전에 다시 확인합니다. 같은 OS 사용자의 키 수정 권한자에 맞서는 원격 인증이라는 뜻은 아닙니다.

물리 경로와 열린 파일 핸들을 대조하며 파일은 바이트 상한 안에서 읽습니다. junction·링크·관측된 디렉터리 교체는 await 이후에도 거부합니다. 임의의 비협조적 파일시스템 writer에 대한 OS sandbox나 원자성 보장은 아닙니다. 이 실패가 일반 Core 작업이나 소스 탐색을 막지는 않습니다.

## 대기 중인 메일 전달

한 주소에 대기 중인 메일은 아래 모든 전달 경로에서 기록된 생성 시각 기준으로 오래된 것부터 넘깁니다.

- **턴이 끝날 때 (Claude Code, Codex).** 수신자 메인 세션의 Stop Hook이 자기 주소로 대기 중인 메일을 찾습니다. 있으면 프롬프트 주입과 같은 형식·제한으로 넘기고, Host가 같은 턴을 그 메일로 이어 갑니다. Claude Code에는 `hookSpecificOutput.additionalContext`로 넘기며, hook 문서는 이를 대화를 이어 가는 피드백으로 설명합니다. Codex에는 메일을 `reason`에 담은 `decision: "block"`으로 넘기며, Codex 소스는 이를 같은 턴의 이어 쓰기 프롬프트로 만듭니다. `SubagentStop`과 `agent_id`가 있는 Stop은 부모의 메일을 가져가지 않습니다. 그 주소의 inbox가 없으면 Stop은 Project를 열지 않고 아무것도 쓰지 않습니다. Hook 출력을 쓴 뒤에만 넘긴 것으로 기록하며, 쓰기가 실패하거나 확인되지 않으면 프롬프트와 똑같이 `unknown`으로 두고 다시 주입하지 않습니다. claim과 commit 사이에 Hook 프로세스가 멈추면(예: 제한 시간) 다음 전달 때 claim한 프로세스가 없음을 보고 `delivery-owner-lost`로 `unknown`을 유지합니다.
- **Claude Code 버전.** Claude Code는 2.1.163부터 Stop Hook의 `hookSpecificOutput.additionalContext`로 턴을 이어 갑니다(변경 이력 기준). 그보다 오래된 버전에서는 메일이 넘긴 것으로 기록되지만 턴은 이어지지 않습니다.
- **한 번에 넘기는 양.** Claude Code는 Hook `additionalContext`를 10,000자까지, Codex는 Stop `reason`과 프롬프트 맥락을 약 2,500 토큰(10,000 UTF-8 바이트)까지 보여 줍니다. 더 길면 파일로 옮기고 모델에는 미리보기와 경로만 전달합니다. 그래서 한 번의 전달은 들어가는 만큼만 오래된 것부터 넘기고, 마지막 줄에 남은 대기 수를 적습니다. 나머지는 다음 Stop이나 프롬프트가 넘깁니다. 형식을 붙인 메시지 하나만으로 더 긴 경우에도 그 메시지는 넘기며, 이때 Host는 미리보기와 경로를 보여 줍니다.
- **시간.** Stop과 UserPromptSubmit Hook의 제한 시간은 15초입니다. Hook 프로세스가 시작된 뒤 처음 6초 안에만 메일을 claim합니다. 그때까지 claim하지 못한 메일은 대기열에 남고, claim했지만 아직 시도하지 않은 메시지는 대기열로 돌아갑니다. 실제 Hook 프로세스를 Windows 11에서 새 Project로 잰 값입니다(첫 프롬프트는 비공개 prompt-reference 폴더도 만듭니다). Stop은 메일이 없으면 약 0.1-0.2초, 하나면 0.7-1.0초, 20개면 1.4-1.7초입니다. UserPromptSubmit은 메일이 없으면 0.6-1.2초, 하나면 1.1-1.9초, 20개면 1.9-2.8초입니다. 그 폴더가 있는 이후 프롬프트는 메일이 없을 때 약 0.6-0.7초입니다. 대부분은 Windows 프로세스 조회입니다. 첫 claim에 프로세스 시작 시각을 남기는 데 약 0.8초, 비공개 prompt-reference 파일에는 작업마다 권한 helper 한 번(약 0.4-0.5초)이 듭니다. Claude Code 프롬프트는 자기 Claude Code 프로세스도 조회하며, 이 조회는 그 helper와 동시에 진행됩니다. 15초는 6초 claim 구간, 이미 시작한 claim 하나, 바쁜 컴퓨터에서 메시지 20개를 쓰고 commit하는 시간을 덮습니다.
- **Lode 쪽 연속 상한 없음.** 메일을 찾은 Stop은 몇 번 연속이든 매번 턴을 이어 갑니다. 서로 계속 답하는 두 세션은 사람이 중단하거나 Host가 멈출 때까지 계속 실행됩니다. Lode는 Host 자체의 반복 보호에 기대지도, 바꾸지도 않습니다. Claude Code 문서에 따르면 Stop hook으로 8번 연속 이어지면 턴을 끝내며 `stop_hook_active`를 넘깁니다. Codex 소스는 `stop_hook_active`를 넘기지만 그런 횟수 제한은 두지 않습니다. Host가 무시한 출력의 메일은 이미 넘긴 것으로 기록되어 있습니다.
- **살아 있는 채널을 찾은 이후 발신.** 발신이 수신자의 즉시 채널(Claude Code inbox 소켓, Codex shared engine)을 찾으면, 그 수신자에게 아직 대기 중인 이전 메일을 새 메시지보다 먼저, 오래된 것부터 각자의 claim으로 넘깁니다. 한 번의 발신은 이전 메일을 최대 10개, 3초까지만 넘깁니다. 처음 `unavailable` 응답이 오면 거기서 멈추고 그 메시지는 대기열로 돌아갑니다. `unknown` 결과는 보존하고 재시도하지 않으며, 새 메시지는 그대로 시도합니다. 발신 결과의 `earlier`에 `handed`·`unknown`·`queued` 수를 적습니다.
- **다음 프롬프트.** UserPromptSubmit은 이전처럼 남은 대기 메일을 넘깁니다.
- **OpenCode.** 플러그인은 watcher가 시작될 때 inbox를 한 번 훑어 그 전에 쌓인 메일을 전달합니다. 세션이 `session.idle`을 알리면 그 세션의 대기 메일을 전달합니다. 요청 transform이 실행 중인 세션은 그 transform 안에서 prompt하지 않고, 그 요청에 메일을 덧붙입니다.

## Provider 어댑터와 검증 범위

- Claude는 관측된 inbox 소켓·named pipe를 씁니다. Windows는 확인된 peer token 없이는 쓰지 않으며, 토큰을 Project 기록에 복사하거나 로그에 출력하지 않습니다. 쓰기 성공은 `sent`입니다. 연결·쓰기 전 실패만 대기시킬 수 있고, 쓰기 시작 후 오류·deadline은 `unknown`입니다. 기본 연결·쓰기 제한은 3초입니다.
- Codex 즉시 전달은 shared-engine 등록이 있을 때만 사용합니다. 기존의 검증된 Go supervisor가 유한한 proxy 프로세스 트리를 소유하며 raw PID/taskkill 정리를 사용하지 않습니다. 정확한 등록 thread를 초기화·resume하고 sandbox·승인 정책을 덮어쓰지 않고 turn을 요청합니다. turn ID가 오면 `delivered`, turn/start 이후 확인이 사라지면 `unknown`입니다. 메시지 turn을 보내지 않은 startup·전송 전 실패만 대기시킵니다. RPC 기본 대기는 각각 3초이며 supervisor 수명과 종료 정리도 제한됩니다. Codex Desktop은 다른 도구가 쓸 수 있는 대기열 API를 제공하지 않습니다. 공유 app-server 소켓이 없으면 메시지는 수신자의 현재 턴이 끝날 때나 신뢰된 Lode hook이 로드된 다음 Codex 프롬프트(데스크톱 스레드 포함)까지 대기합니다. `lode_conversation_list`의 `desktop.codex`에 이 한계를 적습니다.
- Claude Desktop 대화는 목록에 없습니다. 데스크톱 앱이 안정적인 로컬 기록 색인을 공개하지 않아 추측하면 개인 기록을 잘못 나열합니다. 이 프로젝트의 Claude Code 세션은 목록에 있습니다. Claude Code 메시지는 inbox 소켓이 연결되어 있으면 그 소켓으로, 아니면 수신자의 현재 턴이 끝날 때나 다음 프롬프트에 전달합니다. `desktop.claude`에 이 한계를 적습니다.
- OpenCode는 우선 대기시키고 플러그인 watcher, watcher 시작 시 훑기, 수신자의 idle 이벤트 중 하나가 prompt합니다. 메시지 ID가 오면 `delivered`입니다. prompt 호출 이후 오류·timeout·영수증 부재는 `unknown`이며 다시 prompt하지 않습니다. 기본 대기는 30초입니다. 공유 Host 클라이언트를 종료하거나 늦게 완료되는 SDK 요청이 취소됐다고 주장하지 않습니다. v2의 queue형 prompt 인터페이스는 배포된 OpenCode 바이너리에서 아직 검증하지 않았습니다.

Core·MCP·Hook과 프로토콜 실패는 합성 fixture로 검사하며, 실제 Go supervisor가 합성 proxy를 소유하는 검사도 포함합니다. 세 설치 클라이언트 전체의 실사용, 계정 연결이나 실제 모델 이어쓰기 검증을 뜻하지 않습니다. Native-history 이관은 별도의 고정 Codex 버전 메타데이터 기능입니다.

## 발신 ticket과 저장

필요한 경우 OpenCode의 before-tool Hook이 짧은 수명의 caller ticket을 자동 공급합니다. 목록은 서명을 읽기만 하며 소비하지 않습니다. 발신은 대상이 도달 가능하고 우편함이 메시지를 받은 뒤에만 단일 배타 소비 표식을 만듭니다. 대상이 없거나 우편함이 가득 차면 ticket은 다시 쓸 수 있습니다. 동시 사용 중 하나만 허용합니다. 소비 실패는 발신하지 않습니다. 소비 후 중단·응답 유실은 ticket 재사용이나 새 ticket 자동 재서명으로 반복하지 않고 원래 결과의 불확실성을 표시합니다. 키는 HOME/USERPROFILE과 정확한 Project root로 정해지는 Host 비공개 상태이며 운영 상태 root 차이에 의존하지 않습니다.

`.lode/messaging/` 또는 선택된 legacy store의 같은 디렉터리는 폐기 가능한 Host 조정 자료입니다. Project·Session 복구 상태가 아니며, 복사·내보내기로 살아있는 우편함·ticket·프로세스 소유권·endpoint binding을 옮기지 않습니다. presence와 등록 잠금은 Project 밖 Host 전용의 Project별 conversation key 옆에 둡니다. 명시 send 또는 이미 대기 중인 메시지의 handoff만 mailbox 상태를 쓰고, 빈 prompt 조회는 파일을 만들지 않습니다. presence 기간 정리는 등록에서, mailbox 기간 정리는 명시 send에서만 수행하며 list는 두 저장소 모두 변경하지 않습니다. 이전 Project-side presence는 미검증 진단으로만 표시하고 자동 이관하지 않습니다. 관측 전용 Hook의 기존 native 관측·prompt reference·이미 queue된 handoff 계약은 유지하며, Stop은 이미 대기 중인 메일을 넘깁니다. 메일 전달은 저장 상태를 새로 만들지 않습니다. 사용자 ignore·추적 중인 중첩 marker·Git/index 상태 불명은 보존합니다. beta75 이전의 정확한 generated ignore 원문은 새 messaging 규칙과 독립적으로 인식하며, retained snapshot은 여전히 보존할 이력입니다.

inbox 또는 in-flight 파일을 읽지 못하거나 JSON이 메시지 스키마와 다르면, 원본 바이트를 다시 쓰지 않고 `.lode/messaging/quarantine/<id>/payload`로 옮깁니다. 수신자에게는 스캔마다 새 안내를 만들지 않고 `unreadable` 안내 하나를 갱신합니다. `lode_conversation_list`의 `quarantine.count`와 항목 id로 격리 목록을 볼 수 있습니다. 손상된 파일 하나가 있어도 나머지 메시지 전달은 계속됩니다. Claude Code, Codex, OpenCode에 같은 규칙을 씁니다.

기존의 수신자별 200개 메시지·1 MiB 용량과 24시간 보존 기간을 유지합니다. 한 수신자가 가득 차도 다른 수신자는 막지 않습니다. 미전달 대기열의 만료는 제한된 안내를 만들 수 있지만, 결과 불명 인계를 확정 미전달로 설명하거나 재주입하지 않습니다. 목록은 최대 256개와 누락 수를 표시합니다. 운영 자원 범위이며 의미적 충분성이나 권한 판정이 아닙니다.

수신자별 claim 복구·접수·attempt 기록·종료·만료는 기존 P5 로컬 잠금의 짧은 동기 구간에서 원래 claim/attempt를 다시 확인합니다. 실제 전송이나 비동기 대기는 이 잠금을 잡지 않습니다. 경쟁하는 prompt 수신은 기다리지 않고 양보하며, 다른 수신자와 읽기 전용 목록을 막지 않습니다. 이는 공유 실행 권한이나 사용자 승인 게이트가 아닙니다.

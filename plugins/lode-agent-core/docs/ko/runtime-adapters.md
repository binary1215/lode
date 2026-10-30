# 런타임 어댑터 계약

[영어 원문](../runtime-adapters.md)

## 일반 Host 위임과 관리형 런타임

전체 기본은 Lode 직접 작업입니다. 일반 위임은 현재 Host가 이미 제공하는 도구와
짧은 작업 설명·소유 범위·Lode 통합을 사용하며, 워커가 유용하다는 이유만으로
관리형 prepare/execute API를 호출하지 않습니다. Host 기능이 없으면 지원되는
fresh/직접/순차 경로로 계속합니다. 포크 입력은 사용자 범위 안에 두고, 사용자 변경을
보호하며 불명 효과는 반복 전에 확인합니다. 일반 Host 작업에 관리형 격리·lease·
지속 재접속·일회성 적용 보장이 있다고 주장하지 않습니다.

아래 관리형 계약은 복구, 소유권이나 효과 확인이 필요할 때 새로운 유용한 작업과
기존 작업에 사용합니다. 파일 수정, worker 수나 일반 Host 실패만으로 강제하지 않습니다.
권한·원본 기저·lease·정리 검사를 유지합니다. Run을 포함한 위험 lane이 실행기를
선택하지는 않습니다. Host 결과는 증거이지 Canon 승인이나 P2 복구 방향이 아닙니다.
일반 결과에 추가 검토 클릭은 필요하지 않으며, 보호 전환과 활성 Run의 기존 계약은
그대로 유지합니다.

## 일반 Host에서 계획 맥락 연결

큰 작업에서는 완료된 계획 대화를 비활성으로 유지하거나, 기존 Host가 지원하는
별도 보존 포크를 확보한 뒤 원래 대화를 진행합니다. 같은 기준에서 필요한 구현·
상세 검수·판단 통합만 분기합니다. 보존 source에는 일반 작업·접수·확인·probe
메시지를 보내지 않으며 진행 조정과 최신 사용자 조건은 별도 통합 맥락이 맡습니다.
단계 결과와 새 사실·변경 가정·이유·남은 의존성·다음 행동을 통합해 다음 계획을
갱신합니다. 매번 최초 계획으로 되돌아가지 않습니다. 통합 담당은 중요한 원문과
모순을 직접 확인할 수 있고 상세 검수 이력이 자동으로 다음 판단 기준이 되지 않습니다.

현재 노출된 Host read/wait/fork/send의 실제 계약과 반환을 사용합니다. 보이는 계획
텍스트와 완료된 턴, 준비 중 client ID와 ready child, 중단된 상속 턴과 완료 이력은
다릅니다. source 조회는 원자적 cutoff가 아닙니다. 필요한 기준을 확인하되 모델의
내부 상태 동일성을 주장하지 않습니다. child가 이미 실행 중일 수 있으므로 불명
fork·효과는 조사하고 자동 재실행하지 않습니다. 정상 이력 관측이나 실제 작업 child의
제한된 확인은 상속 근거가 될 수 있지만, brief로 정답을 주고 되풀이한 결과는 아닙니다.
현재 취소와 효과 권한은 별도 최신 지시로 전달합니다.

하위 API에 cutoff가 있어도 app wrapper에는 없을 수 있습니다. 이 일반 경로는 아래의
관리형 native-fork 차단을 해제하거나 우회하지 않습니다. source가 이미 진행했다면
fresh·기록 재구성의 한계를 밝히고 유용한 작업을 계속하며 다음 완료 계획에서 실제
보존을 적용할 수 있습니다. 고정된 채팅 수·새 API·registry·daemon·계획 저장·사용자 ID
입력은 필요하지 않습니다. 실제 동작은 Skill의
[계획 보존 흐름](../../skills/lode-agent-core/references/runtime-composition.md#preserved-plan-sources-and-next-stages)을 따릅니다.
지침 소비·지원 Host의 실제 연결·모델 품질 비교는 별도 근거이며 문서나 fixture 성공이
나머지 둘을 증명하지 않습니다.

## 선택적 native 관측

Codex/Claude 패키지 lifecycle Hook은 선택 binding·정본 `.lode`와 별도의
Host-local P5 `native-observations` snapshot만 기록합니다. 기존 native
`lode_project_status`는 이를 쓰기 없이 읽어 text/structured의 선택적
`nativeContext`로 제공합니다. 호출 대화와 조회한 논리 Session은 다를 수 있습니다.
응답 종료·caller 종료 관측은 작업 완료·승인·재실행 권한이 아닙니다.
선택 정보가 없거나 손상·잠금 경합이 있어도 새 복구 gate를 만들지 않습니다.

Snapshot은 128 KiB 안에 최대 64 slot과 실제 replay ID 64개를 보존합니다.
최초 typed 계보 row 최대 2개를 포함하며, 오래된 event부터 제외해 최초에 없던
매핑을 나중 부모 매핑으로 바꾸지 않습니다. 이 범위에서
caller별 최대 200 ms 쓰기 잠금 안에서 병합·원자 교체합니다. 상태 응답의 추가분은
text/structured 중복과 JSON escaping을 합쳐 최대 16 KiB이고 누락 수를 표시합니다.
이는 운영 비용 제한이며 의미적 충분성이나 기존 Capsule·P3 확대 계약을 바꾸지 않습니다.
Daemon·전체 caller registry·transcript 탐색·프로세스 전체 열거는 없습니다.

Codex own 첫 metadata의 명시적 fork/parent를 지원하는 형식에 한해 직접 계보로
사용합니다(upstream `8c076942cb70fba8e5c4732c23f1faabc4aed484` 소스형 검증).
공유 root의 child 소속은 직계 부모가 아닙니다. 최초 edge 보존 시의 논리 매핑은
없었던 경우까지 보존하고 나중 부모 선택으로 덮지 않습니다. `lode_conversation_enter` 진입은 child의
최종 기저 재검사 전에 부모의 검증된 과거 P3 본문을 선택적으로 제공합니다.
부모 P2가 child 방향으로 승격되거나 native fork 당시 복사 이력으로 간주되지 않습니다.
불안정한 metadata 형식 어댑터이지 범용 대화 이력 parser가 아닙니다.

Claude Windows/Linux 관측은 실제 조상 최대 8단계의 exact `<pid>.json`·OS birth로
관계를 확인하고, status에서 기존에 검증된 instance 최대 16개만 한 번 batch 조회합니다.
Registry 부재·권한·미지원·다른 환경은 unknown이며, 확정된 PID 부재/birth 변경도
과거 hosting instance만 한정합니다. 생존은 작업/child agent 활동이 아니고 실제
engine은 종료하지 않습니다. Windows helper만 숨김·유한 실행·소유 정리하며
macOS·remote attestation은 구현하지 않습니다.

`scripts/opencode-plugin.mjs`는 OpenCode v1.19.0 소스형 V1 default `{id, server}`
진입점입니다. 로컬 `.opencode/plugins/lode-agent.js` shim에서 default를 재노출할 수
있지만 설치·사용자 config를 자동 변경하지 않습니다. 이 패키지의
`scripts/mcp-server.mjs`를 실행하는 local config와 충돌 없는 실제 alias만 인식합니다.
실제 event가 공통 P5 writer로 연결되고 raw MCP `tool.execute.after`는 원래 객체에
선택적 status 정보를 더합니다. 공급된 client의 exact Session 조회와 최대 한 번의
bounded status map(O(A))만 사용하며 새 SDK·인증을 만들지 않습니다. Map에 없는
항목은 non-idle 항목 부재이지 종료가 아닙니다. Code-mode와 OpenCode 계보/P3 진입은
이 경로에 포함되지 않습니다.

마켓플레이스 실행 줄은 이식성을 유지합니다. 로드된 Claude 플러그인 안의
`${CLAUDE_PLUGIN_ROOT}`는 Host가 제공하는 정상적인 플러그인 경로입니다.
반면 명시적인 CLI 초기화가 만드는 Claude 프로젝트 설정은 `node`와 선택한
로컬 실행 경로를 검증하며, 플러그인 전용 변수가 있다고 가정하지 않습니다.
소유권이 확인된 standalone 설치에 선택된 command 주소가 기록되어 있으면, 기존
launcher의 내부 MCP 모드를 사용합니다. launcher는 소유권·`current.json`·선택된
release·파일 hash를 확인한 뒤 일반 MCP server를 실행합니다. 기존 설치 marker에
명시적으로 선택한 bin 디렉터리를 기록하며 PATH·기본 설치·최신 cache 검색으로 다른
설치를 고르지 않습니다. 같은 설치 root의 upgrade/rollback 이후 새 실행도 같은 주소를
사용합니다.

command 주소가 없는 구 marker나 marketplace cache처럼 검증된 stable launcher가 없으면
선택된 패키지의 절대 MCP 경로와 작업 디렉터리를 유지합니다. 설치 root가 이동·삭제되어도
자동으로 다른 위치를 찾지 않습니다. 살아 있는 설치를 명시적으로 선택하고 resume/설치
정합화하면 관리 중인 투영을 다시 연결할 수 있습니다. 사용자 소유 설정은 보존하며,
pointer 변경이나 설정 정합화로 이미 실행 중인 MCP를 reload하지 않습니다. 이 로컬
Claude 설정을 다른 기계로 복사할 수 있는 이식형 파일로 간주하면 안 됩니다.

Codex 프로젝트 초기화는 MCP 경로를 쓰지 않습니다. 플러그인 `.mcp.json`은
`node`, `scripts/mcp-plugin-server.mjs`, `cwd` `.`를 유지하고 hook은 `${PLUGIN_ROOT}`를
확장합니다. OpenCode `opencode.json`도 `node`와
`{env:LODE_PLUGIN_ROOT}/scripts/mcp-server.mjs`를 유지합니다. config hook은 이를
메모리 안에서 해석하며 공유 파일에 절대 설치 경로나 Node 경로를 쓰지 않습니다.
`.lode/generated/manifest.json`의 `pluginRoot`는 로컬 설치 정체성입니다.
기본 graph-explorer HTML은 로컬 `project.root`와 `regenerate.argv`를 유지하며
`--share`는 이 재생성 경로를 제외합니다.

패키지의 plugin 진입점은 `scripts/mcp-server.mjs`와 같은 Core를 제공합니다.
검증된 Claude plugin payload·정확한 private Hook tool-use 연결·plugin namespace와
native caller·현재 요청의 정규화한 Project root와 같은 trusted Hook cwd가 모두 있어야
새 프로젝트 `.mcp.json` 생성을 생략합니다. 기존 자식 쓰기 보호가 이 선택적 Project 조회보다
먼저 실행됩니다. 기존 사용자·관리 파일은 보존하며 server를 삭제하지 않습니다. source·
standalone·다른 carrier·근거 부재·잘못된 provenance는 일반 제공 경로를 유지합니다.
ENV·모델 인수·서버명·launch 객체만으로는 증명할 수 없습니다. 나중의 standalone resume은
사용자에게 JSON 작성을 요구하지 않고 부재 파일을 제공할 수 있습니다.

이 설치 context는 요청 종료와 함께 폐기됩니다. 파일 소유권 metadata는 다음 Host에서의
접근 영수증·Session 선택·P2 복구 방향·권한이 아닙니다. package-local 검사에도 원본 hash·
정확한 MCP 투영·entry/module 선언·정확한 파일 tree 검증을 유지합니다. 전체 marketplace의
repository·commit 검사는 별개이며, 로컬 합성 stdio 검사는 실제 설치 Host의 로딩·Hook 변수
해석·모델 수신을 증명하지 않습니다.

`LODE_SUBAGENT_WRITE_GUARD`가 없으면 정확한 호출 연결이 검증된 지원
Claude/OpenCode 자식의 상태 쓰기만 기본 보호합니다. Codex와 근거가 없는 caller는
기본으로 켜지지 않습니다. 명시적 `enforce`는 기존의 더 넓은 확인된 자식 정책을
유지하고, `off`는 이 선택적 Host 보호와 추가 조회·상관 비용을 끕니다. 잘못된 값은
변경된 값마다 한 번만 값을 노출하지 않고 경고하며, 일반 작업을 막는 대신 보호를
끕니다. 카탈로그의 effect metadata로 라우터 내부 도구를 확인한 뒤 MCP 호출마다 한 번,
선택적 Session 연결 안내보다 먼저 판단합니다. 읽기·부모/독립 작업·일반 소스 편집은
계속 가능합니다. 지원되지 않거나 실패한 native 근거는 미확인이며, 보호 성공·권한·
Session 연결로 간주하지 않습니다.

로컬 소스형·소유 OS helper 검증은 실제 설치 Host의 event 전달·모델 도구 선택·긴
compaction UX·전체 활동 파악의 증거가 아닙니다. Codex 현재 대화/turn 상태는 필요할
때 이미 노출된 Host 도구로 확인합니다. [runtime composition](../../skills/lode-agent-core/references/runtime-composition.md#native-observations-and-current-host-activity)을 참조하세요.

## 과거에 준비된 입력

기존 `lode_runtime_invocation_authorization`, `lode_bounded_worker_status`와
CLI `runtime-invocation-read --authorization <id>`의 명시적 read/status 경계에서
선택적 `preparedInput`을 제공합니다. 공유 정본 authorization/dispatch reader와
prepare/execute/apply 검사는 바뀌지 않습니다. 선택적 뷰를 불러오지 못해도 원래
결과는 유지하며, 선택한 authorization 자체의 소유자·digest 오류는 기존대로 실패합니다.

비영속 P4 뷰가 당시의 정확한 authorization·plan·contract·Capsule 및 캡처한
`ProjectDirection` 리비전을 읽습니다. 기존 정본 serializer로 재구성한 입력의 바이트
수와 digest가 `executionInput`에 일치할 때만 `verified-prepared-input`으로 표시합니다.
plan/contract의 기존 Project 범위를 유지하고 Session 소유자를 만들어 내지 않습니다.
현재 소스나 방향으로 과거 원본을 대체하지 않습니다. 원문 부재·무결성 실패·원문
한도와 전체 입력이 보존되지 않은 과거 요청을 구분합니다. 정확한 경로·digest와
최대 2048바이트의 UTF-8 발췌 및 생략량을 제공합니다.

준비, 런타임 receipt 관측, 모델 사용은 별개입니다. 합성 receipt는 합성으로 표시하며,
digest가 일치하는 런타임 관측도 모델 전달·주의·사용을 증명하지 않습니다. Core의
정본 입력이지 전체 Host/모델 프롬프트가 아닙니다. provider·프로세스 실행, 새 snapshot,
native와 authorization의 추정 연결이나 P2 쓰기는 없습니다. 이후 취소와 현재 실행·
복구 검사는 계속 효과를 통제합니다. 일반 native 계보는 나중에 읽은 참고 기록이며
분기 시점의 입력을 재구성한 것으로 취급하지 않습니다.

## 보존된 일회성 worker 계약

관리형 변경은 `node scripts/lode.mjs managed <command> ...` 또는 원래 도구
schema를 사용하는 `lode_tools_call`의 `execution_mode: "managed"`로 호출합니다.
Lode가 라우팅하며 사용자 unlock을 요구하지 않습니다. 원시 관리형 이름은 일반
MCP에서 계속 제한하고 기존 `managed-maintenance` CLI/별도 stdio 서버는 호환
진입점으로 남습니다. Prepare/start/dispatch/execute/apply, reconcile, integration,
wave 변경은 기존 authorization, lease, lineage와 effect 검사를 모두 유지합니다.
기록·상태·대기·결과 조회와 정확한 소유 취소는 일반 경로에 남고 라우팅 자체가
권한을 부여하지 않습니다.

Operating-lane 권고 `0.2.0`은 `executionLane`과 권한 결정을 분리합니다.
자격 증명 사용만으로 Authority를 요구하지 않으며, 승인 범위의 외부 효과나
일회성 독립 검토만으로 Run을 요구하지 않습니다. 의존 결과, 중대한·비가역 효과,
복구 분기가 있으면 Run을 권합니다. `authorizationStatus`는 판단 정보일 뿐
허가가 아닙니다. 기존 런타임 권한은 그대로이며 Session에 외부 쓰기를 허용하지 않습니다.

기존 dispatch/execute/read/wait는 idle Session ExecutionAuthorization도 받습니다.
CLI `managed worker-execute --input <file>`에는 승인 당시와 정확히 같은 `sessionRequest`만
전달합니다. Run·WholePlan·contract·필수 영속 Capsule을 만들지 않습니다. MCP
dispatch/status/wait는 동일 Core를 사용하며 관리형 실행은 명시적 라우팅과 기존 검사를 사용합니다.
관리형 MCP start는 아래의 신뢰된 Host 연결을 사용하며 호출자가 실행 정책을 주입하지 않습니다.
Lode는 결과를 증거로 소비하며 `worker-apply`와 Wave는 Run 전용입니다.
요청된 admission, 소유권·범위 검증, 일회성 lease와 정리 증명은 생략하지 않습니다.
과거 read/wait는 동일 계보와 무결성을 검증하되 현재 active Run을 강제하지 않습니다.
생성·실행에는 여전히 최신 범위가 필요하며 구버전 Run dispatch 재시도는 원본을 보존합니다.

런타임 어댑터 계약 `0.1.0`은 v0.6 공급자 중립 경계를 확립합니다. Runtime-machine-discovery 프로토콜 `0.1.0`은 현재 호스트에서 읽기 전용 실행 파일 탐색을 추가하고, runtime-version-evidence 프로토콜 `0.1.0`은 세션을 만들지 않는 제한된 직접 버전 호출을 추가하며, runtime-protocol-evidence 프로토콜 `0.2.0`은 고정된 공급자별 도움말 표면과 정확한 일회성 옵션 집합을 관찰하고, runtime-project-binding 프로토콜 `0.1.0`은 이러한 관찰 결과를 정식 Lode 프로젝트 및 Session ID에 결속합니다. Execution-authorization 프로토콜 `0.3.0`은 `scope.kind: session | run`과 선택적인 정확한 `provider/model` 선택을 담는 하나의 봉투를 추가합니다. execution-lease 프로토콜 `0.3.0`은 내구성 있는 소비/해제 증거를 운영 소유자 상태와 분리합니다. process-supervisor 프로토콜 `0.1.0`과 매니페스트 `0.3.0`(schema `2`), event-envelope `0.1.0`, structured-result `0.1.0`, lifecycle-receipt `0.6.0`, ResultPacket-draft `0.5.0`은 공통 수명 주기 경계를 통과해 범위를 전달합니다. Claude Code, Codex, OpenCode 일회성 어댑터는 동일한 네이티브 하위 프로세스 트리 감독자와 호출 기록 코어를 공유합니다. 세 어댑터 모두 결정론적 Session/Run 권한 부여, 수명 주기, 이벤트, 결과 및 공급자별 프로토콜 fixture 적합성을 통과합니다. Codex와 OpenCode는 완료된 실제 Session/Run 증거도 보존합니다. Claude Code 실제 모델 호출 적합성은 동일한 opt-in 검증기를 통해 확인할 수 있지만, 실행되기 전에는 충족되었다고 주장하지 않습니다. 새 프로세스를 통한 Codex에서 OpenCode로의 아티팩트 복구도 통과합니다. Lode는 정확히 권한이 부여된 모델과 임시 권한/프라이버시 오버레이만 제공합니다. 공급자 인증과 라우팅은 계속 공급자가 소유합니다. Lode는 공급자 패키지를 합성하지도, 구성된 endpoint를 다시 쓰지도 않습니다. 일반 위임은 Host가 소유하며 선택적 endpoint 연결은 현재 Host snapshot으로 확인합니다. 자체 역할 mail과 전달 bridge는 제거되었습니다. 공급자별 실행 codec은 Host adapter 경계 뒤에 두며 실효 OS·도구 권한 강제에는 신뢰된 연결 backend가 필요합니다. Herdr 특화 socket·pane·TUI 통합은 Core 밖에 둡니다. 공급자 resume과 일반 런타임 제어는 계속 비활성화되어 있습니다.

Supervisor manifest는 프로세스 감독과 파일 효과 진입점을 함께 선언합니다.
Schema `2` / manifest `0.3.0`은 그대로 유지되는 supervisor protocol `0.1.0`과
별개입니다. Manifest `0.3.0`은 제한된 bootstrap 한 줄 뒤에 streaming stdio를
이어가는 별도 `--interactive` protocol `0.1.0`도 선언하며 기존 one-shot protocol은
바꾸지 않습니다. 기능 메타데이터이지 실행·쓰기 허가, Product Canon 승격 또는 P2 복구
권위가 아닙니다. `mutatesCanon: false`가 helper의 물리적 파일 쓰기 불가를 뜻하지는
않습니다. Core가 허용된 효과를 결속하고 runtime platform/target preflight가 각
연산의 실제 지원 여부를 계속 검증해야 합니다.

```text
Lode Core
  -> AgentRuntimeAdapter
       -> Claude Code projection-only reference
       -> Codex projection-only reference
       -> OpenCode projection-only reference
  -> PlatformAdapter
       -> Windows contract reference
       -> macOS contract reference
       -> Linux contract reference
  -> WorkspaceHostAdapter
       -> native-process contract reference
       -> optional verified exact-endpoint attachment
            -> injected provider-neutral WorkspaceHostDriver
                 -> host-export attachment-only current snapshot
```

`AgentRuntimeAdapter`는 메서드 표면 `probe`, `start`, `resume`, `stream`, `interrupt`, `close`를 고정합니다. `PlatformAdapter`는 플랫폼이 소유하는 실행 파일 탐색, 소유 프로세스 시작/검사/종료, 경로, 권한, IPC, 원자적 파일 작업 및 서비스 수명 주기를 고정합니다. `WorkspaceHostAdapter`는 선택적 연결, 현재 endpoint 상태 조회와 연결 해제를 제공합니다. 주입된 driver는 전달을 지원할 수 있지만 filesystem export bridge는 연결 전용입니다. 메시지 큐나 전달 receipt를 쓰지 않으며 `deliverySupported: false`를 표시합니다. 일반 worker 메시징은 Host tool이 소유합니다.

참조 계약 어댑터는 정적 `probe`만 지원합니다. 모든 제어 메서드는 `RUNTIME_ADAPTER_CONTROL_NOT_ENABLED`로 실패합니다. 검증된 Host composition은 exact 선택적 연결·해제를 활성화할 수 있지만 일반 통신은 현재 Host tool이 소유합니다. AgentRuntime이나 Platform 제어를 활성화하지 않습니다. 기본 계약 행렬은 Windows, macOS, Linux의 Claude Code, Codex, OpenCode를 포함하며 다음을 명시합니다:

- `actualPlatformExecutionValidated: false`;
- `actualRuntimeControlValidated: false`;
- `machineInterfacesVerified: false`;
- `runtimeControlEnabled: false`.

이 매트릭스는 결정론적 계약 형태와 권한 경계를 입증합니다. 열거된 모든 운영 체제에 어떤 런타임이 설치되어 있거나, 도달 가능하거나, 재개 가능하거나, 제어 가능하다고 주장하지 않습니다.

운영 일회성 감독자는 정적 `AgentRuntimeAdapter`보다 제어 표면이 더 좁습니다. `spawnBoundedRuntimeOneShot`은 무작위 호스트 전용 token 하나를 한 번만 반환하고, 정확히 소유한 Claude Code/Codex/OpenCode 공급자 트리에 대한 `interrupt` 또는 `close`만 허용하며, 충돌하는 두 번째 작업은 거부하고 네이티브 정리 후 콘텐츠에서 파생된 `RuntimeOneShotControlReceipt`를 내보냅니다. 해당 control receipt에는 token·PID·공급자 session·prompt·transcript를 저장하지 않습니다. 별도의 선택 입력 P3와 output-spool P5 보존은 아래에서 설명합니다. `resume`과 `stream`은 `RUNTIME_ADAPTER_CONTROL_NOT_ENABLED`로 fail-closed합니다. 결정론적 Windows Job Object fixture와 실제로 이미 실행 중인 Codex/OpenCode 클라이언트가 두 작업과 하위 프로세스 정리를 입증합니다. 이는 내구성 있는 공급자 session 제어를 활성화하거나 `ExecutionAuthorization`을 확장하지 않습니다.

Session continuation의 범위는 이보다 더 좁습니다. Core가 먼저 정확한 P2 `SessionRestoreProjection`을 재구축합니다. 그 이후에만 주입된 WorkspaceHost 어댑터가 이미 실행 중인 Lode endpoint를 새로 검증할 수 있습니다. 반환된 P5 `ContinuationOutcome`은 지속되지 않으며 projection을 변경할 수 없습니다. attachment가 없거나, stale하거나, 지원되지 않으면 명시적으로 새로운 논리적 Lode로 fallback합니다. 이는 의미론적 복구에 선택적 대화 연속성을 더한 것이지, 일반적인 공급자 `resume` 또는 `stream`이 아닙니다.

Compaction lifecycle 통합도 선택적 P5 Host 구성입니다.
`CompactionLifecycleHostAdapter`는 정확한 Project, Lode Session, runtime 및
trusted user-turn sequence에 결속된 journaled conversation-entry,
provider-replacement, pre/post-compaction event를 노출합니다. Raw continuation
token은 project Canon 밖에 보관합니다. Core는 읽기 전용 artifact entry restore를
자동 수행하고, 보고된 성공 compaction을 verify하거나 consume하기 전에 P2를
복원합니다. `failed`는 epoch만 abort하고 `uncertain`은 자동 replay하지 않습니다.
Descriptor는 provider/session/process/UI identity와 모든 P1-P4 authority를
금지합니다. Adapter가 없어도 일반 작업과 첫 turn artifact 복구는 가능하고
provider compaction만 Host 소유로 남습니다.

Worker 소유권은 P3 `BoundedWorkerDispatch`로 나타냅니다. Durable 소비·해제 기록은 근거이며 운영 lease 소유권·process·wait 상태는 P5에 남습니다. 기존 네이티브 감독자는 정확한 `ExecutionAuthorization` 하나를 여전히 최대 한 번만 소비합니다. 완료된 실제 공급자 draft가 ResultPacket이 되려면 기존 application gate를 통과해야 하고, 이후 Fresh Lode 검토와 명시적 P2 통합이 필요합니다. Dispatch와 wait는 WholePlan, ReviewDecision 또는 checkpoint direction을 쓸 수 없습니다.

공급자 중립 `BoundedWorkerWave`는 선택적으로 이미 생성된 dispatch 2~64개를 묶어 간결하게 시작 가시성을 제공합니다. 호출자 handle 또는 공급자/Herdr session topology를 저장하지 않고, authorization을 만들지 않으며, lease를 공유하지 않습니다. 명시적 seal에는 모든 독립 authorization의 소비가 검증되어야 합니다. 열린 wave의 aggregate result read와 wait는 fail-closed합니다. P4 status/results 및 P5 wait는 결과를 적용하거나 HF-010 통합을 수행할 수 없습니다. [`bounded-worker-wave.md`](bounded-worker-wave.md)를 참조하세요.

별도의 현재 호스트 탐색 구성은 읽기 전용 `PlatformAdapter`를 사용해 일반 Claude Code, Codex, OpenCode launcher candidate를 찾기 위해 절대 PATH 항목을 검사합니다. 런타임 이름, 가용성, launcher kind, byte length, symlink/direct-spawn safety, 탐색된 경로와 canonical path의 SHA-256 ID만 기록합니다. raw path, environment value, command, argument, 공급자 session, prompt, transcript, endpoint, credential 또는 process identity는 절대 반환하지 않습니다. 읽기 전용 `AgentRuntimeAdapter`는 각 관찰 결과를 선택된 하나의 런타임에 결속하고, native-process `WorkspaceHostAdapter`는 자신의 탐색 경계가 존재한다는 사실만 보고합니다.

현재 Windows 호스트에서 Claude Code, Codex, OpenCode candidate는 이 경계를 통해 탐색됩니다. 탐색 구성은 계속 다음을 기록합니다.

- `machineInterfaceDiscoveryValidated: true`;
- `actualPlatformExecutionValidated: false`;
- `actualRuntimeControlValidated: false`;
- `runtimeControlEnabled: false`.

별도의 버전 증거 구성은 탐색된 네이티브 비 symlink 실행 파일만 고정된 `--version` 인수로 직접 호출할 수 있습니다. workspace-host 경계는 정확히 하나의 자식 프로세스, `shell: false`, 무시되는 stdin, 5초 timeout, 16 KiB stdout/stderr limit, 프로젝트 또는 GraphDB credential을 전달하지 않는 OS 최소 environment를 사용합니다. 공급자 session을 생성하지 않고, 프로젝트 콘텐츠를 전달하지 않으며, 정규화된 semantic version, output digest, byte count, exit state 및 cleanup fact만 저장합니다. raw path와 raw output은 절대 반환되지 않습니다.

현재 Windows 실행은 설치된 Claude Code, Codex, OpenCode의 version surface를 검증했습니다. runtime-version evidence는 선택한 모든 런타임이 정확히 이 비 session probe를 완료한 경우에만 `actualPlatformExecutionValidated: true`를 기록합니다. 계속 다음도 기록합니다.

- `actualRuntimeControlValidated: false`;
- `runtimeControlEnabled: false`;
- `providerSessionCreated: false`;
- `capabilityDoesNotGrantAuthorization: true`.

protocol-evidence 구성은 동일한 direct-child, no-shell, ignored-stdin, minimal-environment 경계를 통해 고정된 help profile을 실행합니다. Claude Code는 non-interactive print mode, stream-json, JSON Schema output, non-persisted session, permission/tool control, disabled skill, bounded setting source, strict MCP isolation, resume/continue discovery를 검사합니다. Codex는 non-interactive execution, JSON event, output schema, color control, sandbox selection, Git-check bypass, working-directory binding, ephemeral execution, resume surface, stdio app-server transport, protocol schema generation을 검사합니다. OpenCode는 non-interactive `run`, JSON event format, resume/continue surface, ACP, project-directory binding, headless server discovery를 검사합니다. Parser output은 allowlist에 포함된 signal name, support status, output digest와 size, exact-child lifecycle fact로 축소됩니다. raw argument, raw help text, path, environment, 공급자 session ID 및 PID는 반환되지 않습니다.

현재 Windows 실행은 Claude Code, Codex, OpenCode에 필요한 non-interactive 및 machine-protocol surface를 관찰합니다. 이는 `actualProviderProtocolObservationValidated: true`를 기록하지만, `actualProviderSessionControlValidated`, provider-session creation 및 runtime control은 계속 false입니다.

그런 다음 `RuntimeProjectBinding`은 version 및 protocol evidence ID를 canonical `.lode/project.json` project ID와 선택된 논리 Lode Session ID에 결속합니다. 기존 `current.json`은 기본 기록입니다. 물리적 project root는 digest로 축소되며 이 probe 동안 어떤 프로젝트 콘텐츠도 전송되지 않습니다. 이는 capability-reference binding일 뿐입니다. 즉, 어떤 Lode project 및 Session이 설치된 interface를 검사했는지를 입증할 뿐, 공급자 session이 생성되었거나 해당 프로젝트에 연결되었음을 입증하지 않습니다.

## 위험 비례 실행 권한 부여

`runtime-invocation-authorize`는 불변 `ExecutionAuthorization` 봉투 하나를 생성합니다. `session` scope는 유휴 Lode Session을 요구하고, user-request digest와 byte count를 기록하며, 로컬에서 되돌릴 수 있는 `project.read` 또는 `project.write`만 허용하고, canon mutation 및 external effect를 금지하며, ContextCapsule을 참조할 수 있습니다. WholePlan, ExecutionContract, Run 또는 Fresh Lode review는 요구하지 않습니다. `run` scope는 정확히 active Run과 digest 검증된 `WholePlanSnapshot`, `ExecutionContract`, persisted `ContextCapsule`을 요구합니다. 계약은 `runtime.invoke`와 선택된 workspace permission을 명시적으로 포함해야 합니다. 두 scope 모두 활성화된 런타임과 관찰된 current-host protocol binding을 요구합니다. 선택적 `runtimeSelection.model`은 제한된 `provider/model` 식별자여야 하며 authorization digest의 일부가 됩니다. 따라서 모델을 바꾸려면 user-global default를 조용히 따르는 대신 새로운 authorization이 필요합니다. 공급자 구현, endpoint 및 credential은 Lode preset이나 semantic graph data가 아니라 운영 OpenCode 설정으로 남습니다.

봉투는 canonical Lode identity, 선택된 scope, runtime, optional model selection, workspace mode, 정확한 allowed-action requirement, project-root digest, capability-evidence ID, execution-input digest/byte count, 제한된 time/input/output/event limit만 기록합니다. credential과 endpoint는 운영 environment input으로 남으며 authorization이나 project artifact에 추가되지 않습니다. 기본 `0.3.0` 봉투는 raw Session request와 reconstructed Run input을 보존하지 않습니다. 선택적 retained-worker `0.4.0`–`0.7.0` 봉투는 선택 맥락·소스 바이트·Session 요청을 `workerInput`의 P3 근거로 보존합니다(`rawContentPersisted: true`). `0.5.0`은 workspace 결속, `0.6.0`은 쓰기 전 상태를 추가하며 별도의 읽기 전용 `0.7.0`은 worker 쓰기 권한 없이 제안 기저를 추가합니다. 이 선택 근거는 원시 대화 transcript가 아니며 P2 방향을 작성할 수 없습니다. Authorization 자체는 공급자를 시작하지 않습니다.

## 내구성 있는 최대 1회 실행 lease

실행 경로는 먼저 정확히 digest 검증된 persisted authorization을 요구한 다음, 운영 직렬화를 위해서만 정확한 PID/token owner로 authorization별 `owner.lock`을 claim합니다. PID, token 및 owner lock은 전용 host-local operational root 아래에 있으며 project tree 아래에는 절대 두지 않습니다. Windows 기본값은 `%LOCALAPPDATA%\lode-agent-core\operational-state`입니다. Unix 계열 호스트는 `$XDG_STATE_HOME/lode-agent-core` 또는 `~/.local/state/lode-agent-core`를 사용합니다. 호스트는 격리된 설치 및 테스트를 위해 절대 `LODE_AGENT_OPERATIONAL_STATE_ROOT` process configuration을 설정할 수 있지만, execution request 및 project file은 이를 선택할 수 없습니다. root, project-local, project-containing, relative, symlinked 및 escaping operational path는 fail-closed합니다.

자식 프로세스가 시작되기 전에 플러그인은 project lineage 아래에 불변 `RuntimeExecutionLeaseConsumption` receipt를 원자적으로 생성합니다. 이 receipt는 authorization hash, project, Lode Session, scope kind, 선택적 Run/ExecutionContract, runtime, caller-fence digest, claim/consumption deadline 및 명시적 경계 `atMostOnce: true` / `replayAllowed: false`를 결속합니다. 소비 후 crash가 발생해도 authorization은 절대 재사용 가능해지지 않습니다. 복구에는 조용한 replay가 아니라 새로운 Lode 결정이 필요합니다.

정확한 자식 프로세스가 종료되거나 작업이 예외를 throw한 후에는 owner lock과 빈 authorization/project operational directory가 제거되고, 공유 host-local root는 남습니다. 불변 project-lineage `RuntimeExecutionLeaseRelease`는 operation status, 선택적 lifecycle-receipt ID 및 exact-owner cleanup을 기록합니다. 소비 전 dead owner는 PID가 존재하지 않음이 입증된 경우에만 복구할 수 있습니다. live 또는 ambiguous owner는 hold deadline이 지난 뒤에도 busy 상태로 남습니다. 플러그인은 알 수 없는 프로세스를 절대 종료하지 않습니다. PID, token 및 operational path는 consumption, release, lifecycle, ResultPacket-draft, CLI 및 MCP artifact에서 제외됩니다. Lease inspection은 `location: host-local-outside-project`와 boolean privacy fact만 공개합니다.

공급자 중립 `RuntimeEventEnvelope`는 JSONL event 하나를 type, class, payload digest, byte count 및 hash된 운영 provider-session reference로 기록합니다. raw payload와 transcript는 이 project-lineage envelope에 저장하지 않습니다. 제한된 raw stdout/stderr는 복구를 위해 별도 Host-local P5 output spool에 보존할 수 있지만 Canon이나 복구 방향이 아닙니다. `RuntimeInvocationLifecycleReceipt`는 PID 또는 raw command를 기록하지 않고 이 envelope와 consumption receipt를 정확한 project, Session, scope, 선택적 Run/contract, caller-fence digest, child-fence digest, exit, timeout/cancellation 및 cleanup fact에 결속합니다. Receipt `0.6.0`은 공급자 error와 internal event/supervisor boundary를 위해 정렬된 allowlist diagnostic code만 추가합니다. raw error text는 임시 상태로 남습니다. `RuntimeResultPacketDraft` `0.5.0`은 이 code를 evidence-only Unknown으로 전달합니다. Run result에는 여전히 Fresh Lode review가 필요합니다. Session result에는 이후 risk transition으로 작업이 Run으로 승격되지 않는 한 명시적으로 필요하지 않습니다.

`RuntimeRunResultApplication` 프로토콜 `0.1.0`은 검증된 실제 공급자 Run draft에서 canonical Execution Lineage로 이어지는 좁은 공급자 중립 bridge입니다. structured result, exact input, project fence 및 native descendant-tree ownership 검사를 모두 통과한 완료된 exit-zero 실제 공급자 Run만 허용합니다. 이 bridge는 제한된 공급자 result를 canonical `ResultPacket` 하나에 mapping하고, 정확한 Run을 `awaiting_review`로 전환하며, 결정론적 Fresh Lode context를 구축하고, invocation record 옆에 콘텐츠에서 파생된 application receipt를 기록합니다. 멱등성을 가지며 receipt write가 중단된 뒤에도 동일한 ResultPacket만 복구할 수 있습니다. 서로 다른 result 또는 Session 범위 result는 fail-closed합니다. receipt에는 transcript, 공급자 session ID, PID, path, instruction authority, promotion authority 또는 Product Canon mutation이 없습니다.

Application 검증과 Run 완료는 같은 session-recovery 변경 잠금 안에서 수행합니다.
누락된 receipt를 복구하며 쓰기 전에 현재 Project·Session·Run·plan·contract·Capsule이
authorization과 정확히 일치해야 합니다. 같은 contract를 재사용하더라도 오래된
결과가 새 Run을 완료할 수 없습니다. 이미 완료된 과거 application receipt는
해당 Run을 다시 열지 않고 조회할 수 있습니다. 이 bridge는 결과를 승인하거나
checkpoint를 만들지 않으며, Fresh Lode 검토와 명시적 통합은 별도입니다.

## 제한된 공급자 일회성 구성

`runtime-invocation-execute`는 persisted Claude Code, Codex 또는 OpenCode `ExecutionAuthorization`을 받아 공급자별 launch/event codec만 공유 authorization, lease, native supervisor, invocation-record 및 result-application core 위에서 dispatch합니다. 각 어댑터는 lease consumption 전에 capability 또는 project-binding drift를 거부하고 shell 없이 absolute native executable을 직접 호출합니다. Claude Code는 non-interactive `--print`, stream-json event, JSON Schema output, `--no-session-persistence`, 로드되는 setting source 또는 slash-command skill 없음, strict empty MCP configuration, workspace mode에서 파생된 exact tool allowlist를 사용합니다. Read-only는 `Read`, `Glob`, `Grep`만 허용합니다. workspace-write는 `Edit`와 `Write`를 추가하면서 Bash, web, notebook, task, plugin 및 external effect를 계속 거부합니다. `--dangerously-skip-permissions`는 절대 사용하지 않습니다. Codex는 JSONL output, ephemeral provider storage, authorization의 정확한 read-only 또는 workspace-write sandbox, Git-repository independence, project-directory binding, deterministic color control, host-local JSON Schema, optional authorized model selection 및 stdin을 통한 정확한 authorized execution input과 함께 `codex exec`를 사용합니다. OpenCode는 `opencode run --format json --pure`, 정확한 project-directory binding, optional authorized model selection, workspace mode에서 파생된 permission projection 및 동일한 bounded stdin/result contract를 사용합니다. 공급자 authentication과 endpoint selection은 계속 공급자가 소유합니다. 각 provider codec은 자체 권한·프라이버시 제한을 요청하지만 모든 setting·plugin·skill이 비활성화된다는 보편적 증명은 아닙니다. 선택 Codex 경로는 `--ignore-user-config`와 `--ignore-rules`를 추가하지만 실행 전에 신뢰된 backend가 실효 지시·도구 격리를 확인해야 합니다. 공급자별 configuration은 Product Canon 또는 graph identity에 들어가지 않습니다.

공통 `RuntimeStructuredResult`는 제한된 `outcome`, evidence statement, `planDelta`, `impactRadius`, verification statement 및 명시적 Unknown을 전달합니다. Codex wire schema는 response 형태를 만드는 데 필요한 portable root-object, required-property, closed-object, scalar, enum, array 및 item subset만 의도적으로 사용합니다. dialect declaration과 type별 length/item constraint는 생략합니다. 이는 공급자 compatibility를 product semantics와 분리합니다. decoding 후에도 공급자 중립 validator는 non-empty field, 64-item list limit, field별 byte limit, 128 KiB total result limit, plan delta와 impact radius를 비워 두어야 한다는 Session rule을 강제합니다. 별도의 JSONL event별 limit 기본값은 2 MiB이고, 호출자가 선택한 더 작은 total stdout limit으로 상한이 정해지며, 8 MiB default total stdout budget으로부터 독립적으로 제한됩니다. raw JSONL과 공급자 message는 project-lineage transcript artifact가 아니라 Host-local P5 output spool 데이터로 남습니다. 공급자 중립 invocation-record core는 콘텐츠에서 파생된 event envelope, lifecycle receipt 및 structured ResultPacket draft만 authorization별 record 아래에 저장합니다. Recovery는 persisted authorization, runtime, project, Lode Session, scope, receipt, event set 및 draft를 하나의 lineage로 검증한 뒤 반환합니다. draft, receipt 및 선택적 verified Run application은 `runtime-invocation-result`와 read-only `lode_runtime_invocation_result` MCP tool을 통해 사용할 수 있습니다. `runtime-invocation-apply-run-result`는 단일 provider draft를 canonical Run lineage로 연결하는 bridge입니다. 여러 결과는 [worker 통합](worker-context-integration.md)과 동일한 기존 Run finish·review 경계를 사용합니다. verified authorization에서 ResultPacket runtime evidence를 파생하며, conforming runtime adapter가 재사용할 수 있습니다. structured result의 absolute project 또는 operational root는 invocation boundary에서 실패합니다.

결정론적 lifecycle verifier는 lease consumption 전 invocation-surface drift rejection, model-selection digest binding, invalid selection rejection, legacy authorization compatibility, portable wire shape, 보존된 semantic bound, privacy-reduced provider diagnostic 및 provider authority 보존을 입증합니다. Claude Code, Codex, OpenCode protocol fixture는 fixed argument, authorized stdin, provider event decoding, immutable recording, CLI/MCP read 및 OS-enforced process-tree cleanup을 입증합니다. 별도의 integrity-verified `lode-agent-supervisor`는 공급자 subtree를 kill-on-close가 설정된 Windows Job Object 또는 격리된 POSIX process group에 할당합니다. native helper manifest digest와 bounded cleanup fact만 durable evidence에 들어갑니다. 실제 Codex 및 OpenCode Run은 각각 정확한 격리 파일을 만들고 다시 읽었으며, protected fixture를 보존하고, native descendant cleanup을 검증하고, canonical ResultPacket 하나를 적용하고, Fresh Lode review를 완료했습니다. Claude Code에는 동일한 live verifier entry point가 있지만 explicit opt-in run이 완료될 때까지 live model-call claim을 하지 않습니다. 별도의 recovery E2E는 Codex를 완료하고, project root와 이전 Lode authorization ID만으로 새 프로세스를 시작하며, artifact에서 canonical Project/Lode Session을 재구축하고, Git, GraphDB 또는 persisted provider-session identity 없이 OpenCode fixture invocation을 완료합니다. 일반 공급자 resume, durable hidden-session restoration, stream, provider-session messaging 및 TUI scraping은 계속 사용할 수 없습니다. P2-first optional exact Lode attachment, exact-owned-tree one-shot interrupt/close 및 authority-free role coordination은 아래의 별도 host boundary를 사용합니다.

추적되는 lifecycle verifier는 provider model execution이 아닌 deterministic capability fixture와 fixed Node execution fixture를 사용합니다. 세 runtime identity 모두의 Session 및 Run scope, authorization runtime에서 공급자별 fixture mode 파생, Session-request drift rejection, model binding, local reversible workspace-write authorization, pre-start consumption, sequential 및 in-flight replay rejection, tamper detection, release inspection, bounded stdin, JSONL validation, exact-child exit, timeout/caller-cancellation termination, Run contract action enforcement 및 scope-correct review requirement를 입증합니다. 별도의 provider-replacement verifier는 새 프로세스를 통한 artifact-only Codex-to-OpenCode recovery proof를 추가합니다. Optional P2-first exact Lode attachment는 활성 상태입니다. 일반 provider resume/stream 및 더 광범위한 runtime control은 계속 비활성화되어 있습니다.

## 선택 작업 폴더 Codex Host 연결과 선택적 fork

선택 작업 폴더 Codex 연결은 신뢰된 Host 경계 뒤에 로컬 구현되어 있습니다.
`buildCodexWorkerPolicyPlan`은 의도를 선언하며 권한 강제를 증명하지 않습니다.
정본 `provider/model`과 `wireModelProvider`·`wireModel`의 정확한 대응을 동결하므로
transport가 다른 모델로 조용히 바꿀 수 없습니다.
`createCodexWorkerPolicyHost`와 `bindCodexWorkerPolicyCapability`는 함수 기반
검증기를 정확한 authorization·input·model·실행 파일·정본 root·선택 실행 root에
결속합니다. 검증기는 기존 lease·provider 실행·정리 동안 실효 정책을 유지하며
소비 직전 callback 안에서 다시 검사합니다. 소비 전 검증은 기존 authorization의
timeout/deadline으로 제한되고 취소 가능하며 새 사용자 한도를 만들지 않습니다.
소비된 작업은 기존 정리 경로의 종료를 기다립니다. 정책 echo·digest·boolean·
직렬화된 JSON 객체는 이 capability가 아닙니다.

Policy `0.2.0`은 검사 대상을 모델에 보이는 task 데이터, 모델이 호출 가능한 도구와
그 효과, 추가로 설정·상속된 지시로 명확히 합니다. Provider 소유의 기본 지시가
의미적으로 아무 영향도 없다고 주장하지 않습니다. 신뢰된 P5 OS·runtime·provider
인증 운영은 별도 actor이지만 일괄 예외는 아닙니다. Host가 정확한 제약을 검증하고
선택하지 않은 task 데이터나 credential을 모델·도구에 노출하는 우회로가 되지 않게
해야 합니다. 이전 `0.1.0` plan을 새 의미로 조용히 재해석하지 않습니다.

분리 실행은 고정 Codex runner와 정확한 hash에 결속된 Host 재연결 모듈을
사용합니다. Provider cwd는 선택 root이며 authorization·lease·결과 저장은
정본 Project에 결속됩니다. Backend가 없거나 검증할 수 없으면 해당 선택 모드만
사용 불가이며 정본 root로 조용히 실행하지 않습니다. 일반 직접/Session 작업은
계속 가능합니다. 합성 계약 시험은 이 연결을 다루지만 설치된 sandbox,
도구·지시·네트워크 강제, 선택 읽기·정확한 쓰기·credential 접근 거부를 증명하지
않습니다. 이 선택 연결은 실제 모델 검증이 완료되지 않았습니다. 2026-09-23 KST
개발 호스트 관측에서 Windows readiness는 `updateRequired`였습니다. 날짜가 있는
환경 관측이지 모든 사용자의 게이트가 아닙니다. 미구현된 설치 실효 정책 backend와
설치 API의 관측 한계는 그 환경 상태와 별개이며 sandbox setup만으로 증명되지 않습니다.
위에 기록된 이전 live one-shot 결과도 이 새 경로의 적합성을 증명하지 않습니다.

`runtime-codex-native-fork.mjs`는 동일한 선택 정책·lease·output spool·결과
경로 위에 Host 전용의 완료 지점 fork 구성을 추가합니다. Inclusive `lastTurnId`가
완료된 cutoff인지, 그까지의 종료된 prefix 내용이 모두 있는지 검증합니다.
앞선 failed/interrupted turn도 보존하며 child identity·model·root·policy,
child goal 억제와 정확한 turn 완료를 확인합니다. Null이 아닌 prefix digest를
authorization 전에 policy에 동결하고 소비 전 다시 대조하며 불확실한 fork/start를
자동 replay하지 않습니다. Source ID·상속 이력·RPC journal은 P5이며 P2 방향을
작성할 수 없습니다. 원본 대화는 변경하지 않습니다. 동시에 바뀐 부모 goal은
관측·unknown 근거로 보고하며 무관한 부모 변경 때문에 worker를 실패시키지 않습니다.
신뢰된 Host가 상속 지시·도구의 취급을 검증해야
하며 prefix digest나 설치된 RPC schema만으로 증명하지 않습니다.
Actual 모드에는 `createCodexNativeForkOwnedTransport({ withVerifiedOwnership })`로
만든 불투명 Host capability가 추가로 필요합니다. Guard가 제공한 동기 factory를
adapter가 소비된 lease 안에서 guard/deadline이 유효할 때만 호출합니다.
Factory는 전달받은 ownership binding을 사용하고 기존 `spawnSupervisedProcess`
handle을 반환합니다. Adapter는 내장 supervisor 출처와 정확한 프로세스·실행 파일·
root·manifest 결속을 검증하며 공유·원본 프로세스, 직렬화된 proof나 이미 finalize된
receipt로 대신할 수 없습니다. 소비 전에 연결을 확인합니다. 완료에는 정확한
transport 종료와 supervisor의 최종 트리 정리 검증이
필요합니다. 소유권 capability가 없으면 소비 전에 사용 불가로 남습니다
(`CODEX_NATIVE_FORK_INSTALLED_ENFORCEMENT_UNPROVEN`). 연결이 있다는 사실만으로
실효 정책이나 실행 성공을 증명하지 않습니다.

`createCodexAppServerTransport`는 고정된 `codex app-server --listen stdio://`
인수와 native interactive supervisor로 실제 P5 stdio 연결을 구성합니다.
검증 경계 안의 factory만 actual 실행을 시작할 수 있습니다. Initialize/initialized
handshake, 제한된 request·notification 대응, server의 승인·도구 효과 요청 거부를
처리하며 불확실한 mutation 전달을 replay하지 않습니다. Close는 EOF를 먼저 보내고
정확한 소유 프로세스 종료·native 정리를 검증하며 강제 종료나 검증 불가를 성공으로
표시하지 않습니다. 별도 protocol-fixture 생성자는 actual 소유 capability를 만들지
못합니다. 전송 구현은 **검증된 production native fork 지원**이 아닙니다. 설치된
실효 정책 backend와 실제 모델 격리·정리는 여전히 미검증이며 transport 시험이 설치된
Codex의 권한 강제를 입증하지 않습니다.

`runtime-codex-worker-host.mjs`는 고정 제품 재접속 진입점인
`connectCodexWorkerHost`와 `createCodexNativeForkJobHost`를 제공합니다.
재접속 자료는 기존 P5 job binding에 들어가며 직렬화된 정책 capability,
새 authorization, 새 Core 아티팩트가 아닙니다. 재접속은 현재 authorization,
선택 workspace, 실행 파일, protocol binding, supervisor를 다시 검증합니다.
모델 없는 backend는 lease 소비 후 실제 소유 stdio·supervisor 경로를 사용하며,
fork 응답 유실 시 정리와 기존 결과 경로까지 연결합니다. 불투명 소유권 capability는
`protocol-fixture`로 구분되어 `actual-provider` Host에 사용할 수 없습니다.
소비된 job마다 P5 transcript 하나를 남기며 상태 조회나 실행하지 않은 재접속은
transcript를 만들지 않습니다.

이는 제품 **구성·재접속**의 연결을 보완한 것이며 설치된 native fork의
**상속 정책 실효 강제**까지 완성한 것은 아닙니다. 고정 진입점은 실제 native 실행을
소비 전에 `CODEX_NATIVE_FORK_INSTALLED_ENFORCEMENT_UNPROVEN`으로 거부합니다.
Schema·profile 응답이나 입력 JSON으로 이를 활성화할 수 없습니다. 기본 공개 fresh
proposal 경로는 그대로이며 native fork나 이 진단을 요구하지 않습니다.

Native 구성 fixture는 **추상 Host 계약 시뮬레이션**이지 Codex API 호환성 증거가
아닙니다. 정확한 0.153.4 소스는 ephemeral fork와 `deferGoalContinuation`의 조합,
turn을 반환하는 ephemeral paginated fork, 생성 후 ephemeral 이력 조회와 goal
접근을 거부합니다. Goals를 끄면 get/clear는 null 대신 오류를 반환합니다. 소스에
맞춘 별도 부정 fixture가 이를 검증합니다. `inspectCodexNativeForkCandidate`는
알려진 API 충돌만 진단하며 capability를 발급하지 않습니다. 전용 프로세스 소유권도
현재의 호환되지 않는 호출 순서를 활성화하지 못합니다. Defer만 제거하거나 몰래
영속 child로 바꾸는 것은 해결이 아닙니다. 후속 제안 전용 모드는 상속 context·도구
경계를 별도로 검증해야 합니다. Fork의 빈 dynamic tools는 원본 이력의 도구를
복원하며, 명시적 base instructions는 저장된 기본 지시보다 우선하지만 과거 메시지를
지우지는 않습니다. 이는 선택적 native backend의 한계이며 일반 fresh proposal에
새 게이트를 추가하지 않습니다.

`inspectCodexInstalledPolicySnapshot`은 보존된 실행 파일·schema·help와 선택적인
날짜 있는 readiness 관측을 읽는 개발자용 진단입니다. 프로세스를 실행하거나 schema를
생성·setup하지 않으며 capability나 authorization을 발급하지 않습니다. 결과는
`enforcementAvailable: false`를 유지하고 backend 부재, typed API 관측의 한계,
환경 관측을 구분합니다. 도구 목록·권한 profile·지시/config echo는 관측일 뿐 완전한
권한 강제 증거가 아니며 다른 build는 새 snapshot 감사를 필요로 합니다. 일반 사용자의
필수 단계·양식·admission gate가 아닙니다. 사용자는 Host proof나 새 JSON 승인을
작성하지 않습니다. [worker 통합](worker-context-integration.md)을 참고하세요.

## 통제된 native-prefix 제안 후보

`CodexNativePrefixPolicyPlan`은 별도 선택 모드인
`native-prefix-patch-proposal`을 정의합니다. 기존 fresh 구성과 선택한 seed
바이트를 결속하며 기존 Lode/provider session·호출자 proof·임의 rollout 경로를
받지 않습니다. 고정 생성자 `createCodexNativePrefixProposalTransport`가 같은
소유 연결에서 직접 legacy 원본을 만듭니다. 프로세스 시작부터 goals와 모델 호출
도구를 끕니다. Seed turn 한 번이 선택 context 수신을 확인하고 직접 관측한 종료
항목이 원본 이력과 일치해야 합니다. Ephemeral fork 응답이 정확히 같은 prefix를
반환한 뒤 명시적 child turn 한 번만 패치를 제안합니다. Goal continuation 연기,
child 이력 조회, child goal 조회는 요청하지 않습니다.

이 모드는 fresh의 ephemeral turn 한 번과 달리 **영속 provider seed 하나와 모델
turn 두 번**을 의도적으로 사용합니다. 소유 프로세스 종료로 seed 이력이 지워지지는
않습니다. 입력 공개·seed 저장·준비 호출 비용은 실제 실행 승인 범위에 들어 있어야
하며 fresh authorization을 추가 효과의 허가로 재해석할 수 없습니다.
동일한 프라이버시 조건의 최적화나 자동 기본값이 아닙니다. 공개 준비 흐름의 기본값은
fresh이며, 명시적인 `context_mode: "native-prefix"`는 이 좁은 controlled-seed 구성을
연결하고 `executionPlan`에 두 turn·영속 seed 효과를 표시합니다. Embedding Host는 기존 authorization·workspace·고정 job API에
이 typed 정책을 조합할 수 있습니다.

`executeCodexNativePrefixProposalInvocation`은 기존 lease·spool·supervisor·제안
결과 경로를 재사용합니다. Mutation 응답 유실을 재실행하지 않으며 원본/fork 불일치나
도구 효과는 결과 수용 전에 실패합니다. Provider ID와 원문 이력은 P5이고 검증된
패치 제안은 P3 근거일 뿐 P2 방향·적용된 변경·리뷰 승인이 아닙니다. 일반 native
정책 0.2는 계속 비활성입니다. 합성 프로토콜/job 시험과 spawn 전에 멈춘 실제 생성자
캡처는 구성만 검증하며 이 모드의 **실제 provider E2E 완료를 주장하지 않습니다**.
일반적인 직접 Lode 작업에는 새 게이트를 추가하지 않습니다.

Transport 정리는 요청 거절·EOF 전달·관측된 프로세스 종료를 구분합니다. 기존 P5
종료 이벤트에는 제한된 수의 단조 시각 진단이 포함되며 새 아티팩트나 실행 전제조건이
아닙니다. 거절된 대기 mutation은 전송되지 않지만 프로세스가 기존 정리 시간 안에
정상 종료한다는 보장은 아닙니다. 강제 정리는 소유 트리가 제거됐더라도 비정상 종료로
유지합니다. 결과 게시 오류 역시 worker 재실행 권한이 아닙니다. 정확한 종료 출력·lease·
owner 종료 근거가 남아 있을 때 명시적인 재대조로 같은 P3 결과를 게시할 수 있으며
P2 방향을 만들지 않습니다.

Fresh와 native 제안은 직접 받은 `item/completed` 근거로 결과를 구성합니다.
`turn/completed` 투영의 `summary`는 반환된 메시지만 대조하며 `notLoaded`는
item을 추가하지 않습니다. 어느 것도 전체 이력을 대신하거나 관측하지 않은 결과를
채우지 않습니다. Native 원본 이력 조회와 fork prefix 대조는 별도의 전체 이력
검사로 유지합니다. 종료 실패·결과 근거 누락·ID 불일치·늦은 효과를 성공으로
승격하지 않습니다.

Native 전용 legacy 대조는 실시간 UUID를 재생성된 `item-N` 식별자와 같다고
가정하지 않고 고정 소스의 저장 투영을 따릅니다. 정확한 seed 입력·저장 순서·빈 값이
아닌 메시지·병합된 reasoning 요약·agent 메타데이터를 결속합니다. 프로세스에만
적용되는 `show_raw_agent_reasoning=false` 설정을 seed 생성 전에 확인하며 fresh
모드는 바꾸지 않습니다. 실시간 v2는 agent 텍스트 조각을 합치므로 순서 있는 본문과
메타데이터의 동등성을 증명할 뿐 관측할 수 없는 원래 조각 경계까지 증명하지는
않습니다. 이후 fork는 ID를 포함한 정확한 저장 prefix를 그대로 보존해야 합니다.
알 수 없는 항목·추가/누락/순서 변경·메타데이터 변경은 이 선택 모드만 실패시키며
fresh 작업을 막지 않습니다.

## 새 patch 제안 backend 후보

`CodexFreshProposalPolicyPlan` `0.1.0`은 별도의 제한된
`fresh-selected-patch-proposal` 모드를 정의합니다. 실제 구성은 버전 문자열만이
아니라 감사한 stock Codex `0.153.4` 소스와 정확한 실행 파일 digest에 고정됩니다.
Selected-exec 정책 `0.2.0`, native fork, 기존 쓰기 authorization `0.6.0`을
완화하거나 자동 대체하지 않습니다.

Authorization `0.7.0`은 선택 입력, 정확한 대상 원본·부재를 담은 읽기 전용
`proposalBasis`를 보존하며 worker 소유 쓰기 경로가 없습니다. Structured result
`0.2.0`에는 digest에 결속된 `patchProposal`을 추가합니다. 모델은 파일 내용을 P3
근거로 제안할 뿐 파일을 적용하거나 시험 실행을 증명하지 않습니다. Core가 후보를
재구성하고 Lode가 판단합니다. Run의 [worker 통합](worker-context-integration.md)은
실제 변경이 있는 적용 시점에만 Lode의 정확한 현재 Run 계약에 `project.write`를
요구합니다. 단일 provider draft 적용 bridge로 이 단계를 우회할 수 없습니다.
Session 결과는 일반 Lode 근거로 남으며 Run이 필수로 바뀌지 않습니다. Graph와 P2
복구 권위도 바뀌지 않습니다.

`buildCodexFreshProposalPolicyPlan`은 모델 대응, 고정 지시·시작 구성과 선택된
Codex-home 지시 digest를 동결합니다. 기존 home 지시는 승인된 입력 범위에서만
정확한 바이트와 provider의 첫 비어 있지 않은 파일 우선순위에 따라 포함하며,
몰래 제외하거나 자동 승인하지 않습니다. 활성 지시가 바뀌면 기저를 새로 선택해야
합니다. 이 구성은 모델이 호출할 수 있는 도구·위임·hook·plugin·skill·MCP·web을
끄고 상속 등록을 명시적으로 닫으며 미선택 지시나 custom provider endpoint를
거부합니다. Provider의 고정 인증·설정용 네트워크 운영은 별도의 P5 기반 동작이며
모델의 네트워크 접근이나 credential·작업 자료 노출 허가가 아닙니다. 이 프로세스에만
적용하며 계정 자격 증명이나 저장 설정을 수정하지 않습니다.

`executeCodexFreshProposalInvocation`은 기존 at-most-once lease·deadline·native
supervisor·output spool·호출/결과 기록을 사용합니다. 실제 transport가 내부적으로
같은 소비된 lease 안에서 고정 `features list`를 먼저 검사한 뒤 App Server를
시작하며 호출자의 callback이나 proof로 대신할 수 없습니다.
`createCodexFreshProposalTransport`가 실효 config·정확한 root의 skill 목록을
검사하고, token refresh 없는 `account/read`와 `model/list`로 ChatGPT 계정·정확한
모델의 준비도를 읽은 다음 새 ephemeral `thread/start`와 정확한 `turn/start` 한 번만
허용합니다. 계정·모델 조회는 준비도 근거이지 모델 E2E 증명이 아니며 계정 원문을
P3에 저장하지 않습니다.
Fork·원본 session 재사용·범용 RPC 경로가 아니며 server의 행동 요청을 거부하고
불확실한 전달을 replay하지 않습니다. 완료에는 정확한 소유 트리 정리가 여전히
필요합니다. Config echo나 호출자 JSON은 capability가 아니며 합성 transport가
actual-provider 연결로 승격될 수 없습니다.

이는 **소스에 고정된 backend 후보**이며 설치 환경의 E2E 지원 검증 완료가 아닙니다.
2026-09-23 개발 검증에서는 승인된 모델 호출 네 번 중 하나도 사용하지 않았습니다.
이는 해당 시험의 허용량이지 제품 제한이 아닙니다. 로컬 계약 시험과 한정 범위 검토는
backend 전체의 수용 판정이 아닙니다. 고정한 설치 실행 파일의 모델 없는 검사는
고정 feature flag와 격리된 합성 Codex home의 config·skill 조회만 확인했으며 계정·
thread·turn·모델 호출은 하지 않았습니다. 내장 로컬 Host의 준비·시작은
명시적인 managed CLI/MCP 라우트에 연결됩니다. Runtime cache를 설치·업데이트하지는 않습니다.
새 사용자 JSON 양식이나 일반 Session 게이트를 만들지 않으며, 선택 모드가
실패해도 정본 작업 폴더에서 조용히 실행하지 않습니다.

`worker-prepare` / `lode_bounded_worker_prepare`는 Lode가 정한 task, 정확한 모델,
member, context, source·proposal 범위를 받습니다. 로컬의 고정 Codex backend를
탐색하고 소유된 모델 없는 feature/config/skill/version/help 검사로 P5 준비를
프로젝트 밖에 보존합니다. 동일한 준비는 같은 authorization을 재사용합니다.
`worker-start --task-key`와 대응 MCP 필드는 별도 모듈 주입 없이 Host를 다시
연결하며 기존 embedding Host도 지원합니다. 임의 실행 파일·runner·환경·강제 적용
주장은 공개 입력이 아닙니다. 지침 기본값은 `selected-only`이며 `host-global`은
명시적인 입력 선택이지 사용자의 더 좁은 범위를 넓힐 권한이 아닙니다. 계정·모델
준비도는 실제 실행 때 확인합니다. 준비는 쓰기 권한이나 Run을 만들지 않습니다.
명시적 관리형 CLI/stdio MCP 경로는 모델 없는 native fixture로 검증했고 stock Codex 준비는
계정·thread·모델 호출 없는 관측으로 검증했습니다.

실행 전에 선택 소스·변경 전 상태가 바뀌면 task 이름 변경이나 캐시 삭제 없이
같은 member를 새 정확한 기준으로 다시 준비할 수 있습니다. Lode는 준비 후 새로
생긴 제안 대상 파일을 포함해 읽기 소스 경로를 명시적으로 다시 선택할 수 있습니다.
업무·모델·제안 대상·제한·지시 범위는 유지하며, 새 선택과 정확한 bytes를 별도 준비에
결속합니다. 자동 범위 확대는 아닙니다. 이전 준비는 불변으로
보존하며, 후속 권한이 안전한지는 기존 Core member/lease 트랜잭션만 판단합니다.
살아 있는 owner나 실행되지 않았다는 증거가 없는 소비된 결과는 우회하지 않습니다.
짧은 P5 출판·복구 단계만 직렬화하고 탐색이나 실행 동안 잠금을 유지하지 않습니다.
hardlink 출판이 중단되면 동일 bytes·inode로 검증한 본인 staging 링크만 제거하며,
알 수 없는 링크는 보존하고 거부합니다. 이는 운영 복구이며 사용자 승인 게이트나
P2 방향의 출처가 아닙니다.

## 일반 위임과 선택적 연결

일반 bounded 위임에는 현재 Host의 task/message/progress를 사용합니다.
Lode 역할 token, generation, inbox나 append-only target chain은 없습니다.
message와 worker 성공은 증거이지 실행 권한이나 승인이 아닙니다.
[일반 Host 위임](role-coordination.md)을 참고하세요.

`VerifiedWorkspaceHostAdapter`는 Project root와 logical Lode Session 안의
현재 exact endpoint에 선택적으로 연결합니다. Host 검사 전에 P2를 복원하며,
연결 불가 시 같은 logical Lode로 fallback합니다. portable `host-export`
composition은 외부 현재 snapshot 하나를 저장합니다.
`workspace-host-export-mcp.mjs`는 Host가 제공한 project/caller/export 설정과
process-ownership proof만 받습니다. attachment 전용이며 delivery request/claim/ack나
worker launcher를 제공하지 않습니다.

과거 live role-mail test와 새 경량 구현을 동일시하지 않습니다.
현재 source와 local fixture는 endpoint identity·교체·손실, fallback과 P2 방향
불변을 검증하며 새 실제 provider E2E는 별도입니다.

## 권한 및 ID 경계

런타임 capability는 절대 authorization을 부여하지 않습니다. 향후 제어 작업도 유효한 Session 또는 Run `ExecutionAuthorization`, 정확한 project binding, caller identity, owned-process evidence, resource limit 및 cleanup으로 제한되어야 합니다. Run scope만 accepted ExecutionContract와 ResultPacket/ReviewDecision lineage를 요구합니다.

Lode Session 및 Run ID는 계속 canonical project identity입니다. Provider session ID는 P5 operational reference로 남으며, Lode identity를 대체하거나 core semantic identity에 들어갈 수 없습니다. original provider process와 provider session이 사라진 경우에도 verified Lode artifact에서 복구할 수 있어야 합니다. Probe·event·lifecycle 투영은 raw provider session ID·명령·endpoint·transcript·credential·출력·live process identity를 제외합니다. Retained worker authorization은 선택 입력과 저장소 상대 소스 경로를 의도적으로 P3 근거에 보존하며 raw transport·이력은 Host-local P5에 둡니다. 어느 쪽도 P2 방향이 되지 않습니다.

모든 descriptor 및 probe는 다음을 요구합니다.

- `instructionAuthority: false`;
- `promotionAuthority: false`;
- `controlAuthority: false`;
- `mutatesCanon: false`;
- runtime adapter의 경우 `tuiScraping: false`.

static contract descriptor는 추가로 `capabilityAuthority: none`을 요구합니다. 반면 operational discovery, version 및 protocol-evidence composition은 `authority: operational-observation-only`와 `capabilityDoesNotGrantAuthorization: true`를 선언합니다. project binding은 canonical Lode reference와 operational evidence를 결합하지만 instruction, promotion, control 또는 canon-mutation authority는 없습니다.

Control·mutation·TUI scraping 또는 다른 session-identity rule을 내세우는 정적 참조 descriptor나 probe는 사용 가능한 것으로 취급되지 않고 validation에 실패합니다. 별도로 연결한 운영 adapter는 각자의 정확한 권한 경계를 유지합니다.

## 경계 검사

CLI command는 read-only입니다.

```text
node scripts/lode.mjs runtime-adapters <project>
```

read-only MCP tool은 `lode_runtime_adapters`입니다. 둘 다 `.lode/project.json`에서 선택된 runtime을 사용하며, 결정론적 three-platform/three-runtime contract matrix, current-host privacy-bounded discovery, bounded version 및 protocol evidence, canonical Lode project/Session capability binding을 반환합니다. 위에서 설명한 정확한 short-lived version 및 fixed-help child만 시작할 수 있습니다. provider session을 생성, resume, message, interrupt 또는 close하지 않습니다.

Authorization 준비 자체는 provider를 실행하지 않습니다. 별도 CLI 연산으로 idle Session 또는 active contract-bound Run의 권한을 준비·조회하고 명시적으로 실행·근거 적용을 수행합니다.

```text
node scripts/lode.mjs runtime-invocation-authorize <project> --input <authorization.json>
node scripts/lode.mjs runtime-invocation-read <project> --authorization <execution-authorization-id>
node scripts/lode.mjs runtime-invocation-lease-status <project> --authorization <execution-authorization-id>
node scripts/lode.mjs runtime-invocation-execute <project> --authorization <execution-authorization-id> --input <execution.json>
node scripts/lode.mjs runtime-invocation-result <project> --authorization <execution-authorization-id>
node scripts/lode.mjs runtime-invocation-apply-run-result <project> --authorization <execution-authorization-id>
```

input에는 `runtime`, `scope`, `workspaceMode` 및 optional `limits`가 들어 있습니다. Run scope는 `{ "kind": "run" }`입니다. Session scope는 `{ "kind": "session", "request": "...", "contextCapsuleId": null }`입니다. request는 bounded stdin payload를 파생하며 선택적 retained-worker 입력을 사용할 때만 보존됩니다. read-only MCP tool `lode_runtime_invocation_authorization`과 `lode_runtime_invocation_lease_status`는 persisted authorization 하나와 available/claimed/consumed/released state를 검증합니다. 이 읽기 전용 도구는 권한을 생성·소비·해제하지 않습니다. 선택적 `lode_bounded_worker_start`는 신뢰된 Host 연결과 기존 lease로 실행을 위임하며 소비된 authorization을 replay하는 공개 도구는 없습니다.

추적되는 verifier는 다음과 같습니다.

```text
npm run verify:runtime-adapters
npm run verify:runtime-lifecycle
```

명시적 live verifier는 실제 provider model call과 하나의 isolated workspace write를 수행하므로 normal regression과 의도적으로 분리되어 있습니다. build되고 integrity-verified된 native supervisor와 deliberate opt-in이 필요합니다. 기본값은 이미 적합성을 확인한 Session을 건너뛰는 `run-only`입니다. `session-and-run`은 더 완전한 regression path를 유지합니다. mode는 product-level model-call quota를 부과하는 대신 coverage를 선택합니다. legacy `LODE_AGENT_LIVE_CODEX_E2E` name은 compatibility를 위해 계속 허용됩니다.

```text
LODE_AGENT_LIVE_RUNTIME_E2E=1 LODE_AGENT_LIVE_RUNTIME=codex LODE_AGENT_LIVE_RUNTIME_E2E_MODE=run-only npm run verify:live-runtime
LODE_AGENT_LIVE_RUNTIME_E2E=1 LODE_AGENT_LIVE_RUNTIME=opencode LODE_AGENT_LIVE_RUNTIME_MODEL=provider/model LODE_AGENT_LIVE_RUNTIME_E2E_MODE=session-and-run npm run verify:live-runtime
LODE_AGENT_LIVE_RUNTIME_E2E=1 LODE_AGENT_LIVE_RUNTIME=claude LODE_AGENT_LIVE_RUNTIME_MODEL=anthropic/model-name LODE_AGENT_LIVE_RUNTIME_E2E_MODE=session-and-run npm run verify:live-runtime
```

environment opt-in이 없으면 provider invocation을 만들기 전에 실패합니다. 지원되지 않는 optional mode도 fail-closed합니다. deterministic fixture를 통과하거나 application bridge를 구현한 것은 live provider conformance로 간주되지 않습니다.

adapter verifier는 deterministic contract identity, Claude Code/Codex/OpenCode coverage, Windows/macOS/Linux matrix, current-host discovery, version 및 protocol-evidence schema, canonical project/Session capability binding, disabled static-adapter control method, authority-escalation rejection, tamper rejection 및 privacy boundary를 입증합니다. supervisor verifier는 남아 있는 grandchild가 있는 실제 provider fixture를 대상으로 Windows Job Object normal-exit, cancellation, token-fenced bounded interrupt 및 token-fenced bounded close cleanup을 입증합니다. CI는 Linux에서 POSIX process-group implementation을 compile하고 run하며 모든 release target을 cross-build합니다. lifecycle verifier는 세 runtime 모두에서 두 authorization scope, Session-request 및 model binding, Run/contract/Capsule binding, durable single consumption 및 release, sequential/concurrent replay rejection, bounded event, provider-neutral record recovery, provider-specific protocol-fixture validation, native-supervised protocol extraction, timeout, caller cancellation, scope-correct write policy 및 live provider 없이 transcript-free result drafting을 입증합니다. provider-replacement verifier는 runtime change를 가로지르는 fresh-process artifact recovery를 입증합니다. child creation을 거부하는 sandbox는 runtime absence 또는 successful execution으로 오인되는 대신 명시적 operational failure를 냅니다.

## 다음 활성화 gate

읽기 전용 경로 탐색, 제한된 비세션 version 호출, provider별 protocol/capability 관찰, canonical Lode identity 결속, 선택적 exact-endpoint attachment와 exact-owned one-shot interrupt/close가 활성화되어 있습니다. 과거 live role-message 검증은 개발 증거이지 현재 구현 검증이라는 주장이 아닙니다. 일반 static-adapter start, provider-session resume/stream 또는 더 넓은 process-host control을 활성화하기 전에는 composition이 다음을 검증해야 합니다:

1. externalized operational-state root, 정확한 authorization/lease/caller/project fence 및 verified native descendant supervisor를 통해 완료된 live Codex Session conformance evidence를 보존할 것
2. actual provider input, structured event, isolated file write, ResultPacket evidence 및 provider-neutral schema를 통한 provider-specific error를 포함하여 evidence-led consequential live Codex Run을 대상으로 진단된 large-event fix를 검증할 것
3. process termination을 session control로 재사용하지 않고 별도의 resume/stream protocol을 추가하면서 완료된 live one-shot interrupt/close evidence를 보존할 것
4. actual provider-session binding을 operational-only로 유지할 것
5. canon, ReviewDecision, instruction 또는 promotion authority가 없을 것
6. Session request identity 또는 Run WholePlan/Capsule/ExecutionContract identity와 evidence lineage를 보존하는 failure behavior를 갖출 것

point-in-time `RuntimeStateAdapter` export는 별도의 evidence-only facility로 남습니다. 이들은 이 control activation gate를 충족하지 않습니다.

## 선택적 Host capacity admission

Provider-neutral Host는 기존 bounded-worker dispatch를
[worker-admission.md](worker-admission.md)의 선택적 P5 admission 계약 뒤에 둘
수 있습니다. Admission capability는 execution JSON이 아니라 별도의 branded
내부 인자로 runtime lease에 전달됩니다. Admission을 설정하지 않은 Host는
기존 invocation 순서와 public surface를 정확히 유지합니다.

## 선택적 proposal 실행 관측

신뢰된 in-process Host는 기존 fresh/native-prefix proposal executor의 두 번째
인자로 opaque `createCodexProposalExecutionControl` capability를 전달할 수
있습니다. 하나의 authorization hash와 기존 실행 기한을 단축만 할 수 있는 절대
deadline에 결합합니다. 동기 `beforeTurn` 훅은 물리적 turn write 전에 호출되므로
Host가 별도의 실험 원장에 durable debit을 기록할 수 있습니다. `onTerminal`,
`onEvent`, `onCleanup`은 권한이 아닌 증거를 관측합니다. 같은 executor의 policy,
config, skills, account/model, prefix, result/schema, receipt 및 P3 lease 검사는
유지됩니다. 훅이 실행 파일을 선택하거나 executor를 대체하지 않습니다.

이 훅은 CLI/MCP JSON 필드·공유 worker 권한·기본 quota·P2 복구 상태가 아닙니다.
진단 오류는 operational error로 보존하고 해당 실행을 중단하되 supervisor의
control/exit parser에 예외를 전달하지 않습니다. exact-owned cleanup은 선택적
원장 정산보다 먼저 수행합니다. 저장 실패로 release나 성공 결과를 꾸미지 않으며,
turn 완료와 프로세스 종료 확인은 별개 관측입니다. 선택적 control이 없는 호출의
기존 권한과 실행 예산은 그대로 유지됩니다.

로컬 fixed-peer 실험의 총량·동시성·시간 한도와 테스트 전용 Lode consumer는
공개 플러그인 정책이나 durable worker-job 통합 workflow의 대체물이 아닙니다.
actual factory가 있다는 사실은 live provider 적합성 증거가 아닙니다. 로컬 검증은
기본적으로 actual provider를 시작할 수 없어야 합니다.

## 시작 안내와 Claude 파일 소유권

생성된 Core 지침, 지원되는 시작 투영, 명시적 bootstrap 응답은 같은 최소 작업 지속
안내를 공유합니다. 기존 전체 JSON 예산(Claude 10,000, Codex/OpenCode 32,768 UTF-16
문자)에서는 현재 목표·취소·선택된 Session 복구 내용·Todo·들어갈 수 있는 원래 이유가
우선입니다. 시작 출력의 `coreGuidance`는 선택적 필드이며, 공간이 있으면
`coreGuidanceDelivery`에 안내 생략을 표시합니다. 필드가 없다고 전달을 입증하는 것은
아닙니다. 출력 객체 생성이나 로컬 Hook stdout은 Host/모델 수신·준수를 증명하지
않습니다. 복구나 선택이 불확실해도 종속 작업만 영향을 받으며, inventory 전수 조회나
새 checkpoint를 선행 조건으로 만들지 않습니다.

Claude의 `CLAUDE.md`와 `.mcp.json` 소유권은 독립입니다. 기존 사용자 파일은
보존하고, 선택한 Claude runtime의 다른 파일이 없으면 관리 파일을 제공할 수 있습니다.
기존의 통합 소유권 metadata도 계속 읽습니다. 명시적 resume는 이전에 관리하지 않던
부재 파일만 원자적으로 덮어쓰기 없이 만들고 기존 관리 manifest를 갱신할 수 있습니다.
중간에 사용자 파일이 생성되면 그 파일을 보존합니다. 이미 관리하던 원문이 없어진 것은
드리프트이며 재생성 권한이 아닙니다. 다른 runtime이나 기존 사용자 MCP 설정을
자동으로 소유하거나 병합하지 않습니다.

플러그인 Hook이 없는 경우에도 명시적 초기화/resume의 구조화 응답에 `coreGuidance`가
있고, 생성된 지침 투영을 보존합니다. 사용자 지침 파일을 보존했다는 사실로 Host가
생성 지침을 읽었다고 주장하지 않습니다. 기존 preserve/link 선택을 유지하며 자동
수신·영속 전달 상태·실제 native 로딩을 추정하지 않습니다.

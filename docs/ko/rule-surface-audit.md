> 이 문서는 [rule-surface-audit.md](../rule-surface-audit.md)의 한국어판입니다. 코드, 명령, 프로토콜 식별자와 필드 이름은 원문 표기를 유지합니다.

# 규칙 표면 감사

측정: 2026-11-13, 0.3.0-beta.118 기준(`main` 커밋 `68d41b8`에 beta.118 변경을 적용한 상태).

이 감사는 Lode가 모델에게 요구하는 글의 양과 호출 수, 그리고 남아 있는 런타임
규칙을 기록합니다. 아래 숫자는 표에 손으로 센 값이라고 적힌 경우를 빼면 모두 그
커밋에서 `node scripts/audit-metrics.mjs`로 얻은 값입니다. 전체 보고서는 `--json`을
붙이면 나옵니다.

스크립트는 출력만 합니다. 한도가 없고, 어떤 값에도 실패 종료 코드를 내지 않습니다.
한도를 넘으면 실패하는 CI 검사는 배제했습니다. 숫자는 판단의 근거일 뿐 판단을
대신하지 않습니다. 스크립트는 저장소에 아무것도 쓰지 않습니다. 저장과 재개 흐름은
시스템 임시 디렉터리 아래의 임시 프로젝트에서 프로세스 내 MCP 서버로 실행하고,
끝나기 전에 지웁니다.

## 항상 읽히는 지침

모델이 요청하지 않아도 모든 세션에서 받는 글입니다.

| 출처 | 전달 방식 | 문자 수 | 금지 표현 |
| --- | --- | ---: | ---: |
| 진입 문단(`coreEntryGuidance`) | MCP `initialize` instructions | 822 | 1 |
| SessionStart 맥락, 새 core 프로젝트 | Claude Code와 Codex Hook `additionalContext`, OpenCode 시스템 프롬프트의 같은 시작 맥락 | 1,909 | 2 |
| `lode-agent-core` Skill 설명 | Skill 목록 | 342 | 0 |
| `lode-agent-onboarding` Skill 설명 | Skill 목록 | 408 | 1 |
| `lode-conversation` Skill 설명 | Skill 목록 | 219 | 0 |
| 프로젝트 지침(`lode-instructions.md`) | 루트 `CLAUDE.md` / `AGENTS.md` / `opencode.json`, 쓰거나 연결한 경우에만 | 2,301 | 1 |

| 합계 | 문자 수 | 금지 표현 |
| --- | ---: | ---: |
| 기본(앞의 다섯 행) | 3,700 | 4 |
| 기본, 진입 문단을 한 번만 셈 | 2,878 | |
| 루트 지침 파일 포함(여섯 행 전부) | 6,001 | 5 |
| 루트 지침 파일 포함, 진입 문단을 한 번만 셈 | 4,357 | |

참고:

- 초기화는 기본으로 루트 지침 파일을 쓰지 않습니다. 새 core 프로젝트에서는 Claude,
  Codex, OpenCode 지침 연동이 모두 `withheld`를 보고합니다. 두 옵션이 프로젝트
  지침을 항상 읽히게 합니다. `write_root_instruction_files`를 켠 프로젝트는 생성된
  `lode-instructions.md`와 같은 `CLAUDE.md`와 `AGENTS.md`를 받고,
  `instruction_integration: "link"`를 켠 프로젝트는 그것을 불러오는 관리 블록을
  받습니다(Claude Code에서는 `@` 줄, Codex와 OpenCode에서는 읽으라는 안내).
- 진입 문단은 SessionStart 맥락과 프로젝트 지침 안에 다시 들어 있습니다. "한 번만
  셈" 행은 그 반복을 뺀 값입니다.
- SessionStart 맥락에는 프로젝트 경로가 JSON 이스케이프된 채로 두 번 들어 있습니다.
  그래서 1,909와 이를 포함한 모든 합계는 프로젝트 위치에 따라 달라집니다. 측정에는
  Windows에서 이스케이프 후 73자인 임시 경로를 썼고, 7자 짧은 경로에서는 1,895자
  입니다. 스크립트는 자신이 본 경로 길이를 함께 출력합니다.
- SessionStart 맥락은 기록된 방향이 늘면 커집니다. 저장을 한 번 한 뒤에는 3,842자
  였습니다.
- 기본 도구 목록도 세션마다 전달됩니다. 이 합계에는 들어 있지 않으며, 아래 도구
  표면에서 따로 재고 그 안의 금지 표현도 따로 셉니다(31개).

## 금지 표현

스크립트는 `never`, `do not`, `must not`, `cannot`을 셉니다. 전체 글에서 대소문자를
가리지 않고 단어 단위로 맞춥니다. 0.3.0-beta.110 측정이 쓴 목록과 같고,
0.3.0-beta.109는 "never"와 "do not"만 셌습니다(변경 기록 참고). "must"나
"forbidden" 같은 다른 강한 낱말은 세지 않습니다.

세션마다 전달되는 기본 `tools/list` 결과에는 이 표현이 31개 있습니다("never" 29,
"cannot" 2). 지침 글과는 따로 셉니다.

| 파일 | 문자 수 | 금지 표현 |
| --- | ---: | ---: |
| `skills/lode-agent-core/SKILL.md` | 11,939 | 15 |
| `skills/lode-agent-onboarding/SKILL.md` | 11,411 | 25 |
| `skills/lode-conversation/SKILL.md` | 3,887 | 3 |
| `references/authority-and-roles.md` | 4,496 | 11 |
| `references/context-compiler.md` | 10,744 | 16 |
| `references/context-workflow.md` | 2,115 | 2 |
| `references/conversation-ux.md` | 11,972 | 6 |
| `references/project-discovery.md` | 10,487 | 4 |
| `references/recovery-workflow.md` | 10,350 | 4 |
| `references/runtime-composition.md` | 13,539 | 8 |

4-C 단계에서 다시 쓴 네 참조(conversation-ux, recovery-workflow,
runtime-composition, project-discovery)는 합계 46,348자, 금지 표현 22개입니다.
파일별 개수는 4-C 결과(6, 4, 8, 4)와 같습니다. 문자 합계가 당시 기록한 44,905보다
큰 것은 0.3.0-beta.111과 0.3.0-beta.115 사이에 `recovery-workflow.md`가 8,907자에서
10,350자로 늘었기 때문입니다.

## 도구 표면

| 표면 | 도구 수 |
| --- | ---: |
| 기본 `tools/list` | 22 |
| `managed-maintenance` 서버 `tools/list` | 53 |
| 목록 카탈로그(`lode_tools_discover`로 도달, 19개는 기본 목록에도 있음) | 50 |
| 사용 중단 이름을 포함한 모든 operation | 143 |

기본 `tools/list` 결과는 JSON 29,201자입니다(UTF-8 29,201바이트, 모두 ASCII).
도구 스키마를 미루는 Host는 모델에게 이보다 적게 보낼 수 있습니다. 스크립트는
서버가 돌려주는 것을 잽니다.

## 저장, 재개, 위임 호출 수

저장과 재개는 스크립트로 잽니다. 스크립트는 각 순서를 임시 core 프로젝트에서
프로세스 내 MCP 서버로 실행하고, 실제로 보낸 호출과 결과(저장 `created`, 저장한
목적을 돌려주는 재개)를 보고합니다. 검증된 호출자는 Host가 식별하는 방식대로
흉내 냅니다. Codex는 `threadId`, Claude Code는 호출마다 앞선 PreToolUse 훅 준비입니다.
CLI 행은 스크립트가 실행하지 않으며, 검증되지 않은 MCP 호출자와 같은 두 작업입니다.

| 작업 | 호출자 | Lode 호출 | 순서 |
| --- | --- | ---: | --- |
| 저장 | 검증되지 않은 MCP 호출자 | 2 | `lode_checkpoint_basis` 다음 `lode_checkpoint_sync` |
| 저장 | CLI(스크립트로 실행하지 않음) | 2 | `checkpoint-basis` 다음 `checkpoint-sync` |
| 저장 | Host가 검증한 호출자, 진입 후 | 1 | `lode_checkpoint_sync` |
| 재개 | 새 대화, 검증되지 않은 MCP 호출자 | 1 | `lode_conversation_enter` |
| 재개 | 새 Codex 스레드 | 1 | `lode_conversation_enter` |
| 재개 | 새 Claude Code 대화, Session이 하나인 Project | 1 | `lode_conversation_enter` |
| 재개 | 새 Claude Code 대화, Session이 여럿인 Project | 2 | `lode_session_list` 다음 사용자가 고른 `session_id`를 준 `lode_conversation_enter` |
| 재개 | 압축 뒤 같은 Codex 스레드, SessionStart Hook 사용 | 0 | Hook이 저장된 방향을 전달 |

Claude Code 행은 Skill 진입 표대로 각 단계가 돌려준 상태를 따라간 결과입니다. 새
Claude Code 대화에는 Session 연결이 없고, SessionStart Hook은 여전히 아무것도 고르지
않습니다(`session_selection_unresolved`). Project에 Session이 하나면 Hook의
`reasonCode`는 `SINGLE_SESSION_ENTRY_AVAILABLE`이고 `sessionDiscovery.call`은
`lode_conversation_enter`입니다. 진입은 그 요청에 한해 그 Session으로 답해 저장된
방향을 돌려주며, 연결은 쓰지 않습니다. Session이 여럿이면 Hook은
`SESSION_SELECTION_LOST`와 `lode_session_list`를 주고 사용자가 고릅니다
(0.3.0-beta.118부터. 그 전에는 새 Claude Code 대화가 어느 경우든 두 번 호출했습니다).

위임은 문서화된 경로를 손으로 센 값입니다. worker 실행에는 모델 제공자가 필요해서
스크립트로 재지 않습니다. 4-E 단계(가벼운 managed worker 경로)는 만들지 않았으므로
지금의 숫자입니다.

| 경로 | Lode 호출 | Host 호출 | 출처 |
| --- | ---: | --- | --- |
| 일반 Host 위임(기본) | 0 | worker당 1 | [runtime composition](../../skills/lode-agent-core/references/runtime-composition.md) |
| managed worker, 시작부터 고정된 patch까지 | 최소 4 | 0 | [worker 통합](worker-context-integration.md) |
| managed worker, 고정된 patch부터 통합된 Run 결과까지 | 4 | 0 | [worker 통합](worker-context-integration.md) |

managed 시작은 `lode_bounded_worker`(prepare), `lode_bounded_worker`(start), 작업이
끝날 때까지 한 번 이상의 `lode_bounded_worker_job_status`, 그리고
`lode_bounded_worker_job`(patch)입니다. 통합은 `lode_worker_integration`의 prepare,
apply, prepare-result, publish-result입니다. Run을 여는 호출과 이후 검토는 세지
않습니다.

## 이력

아래 이전 값은 변경 기록과 설계 기록에서 왔습니다. 이 스크립트가 아니라 당시에 잰
값입니다.

| 변경 | 전 | 후 | 릴리스와 PR |
| --- | ---: | ---: | --- |
| 프로젝트 지침(`lode-instructions.md`), 문자 수 | 8,381 | 2,301 | 0.3.0-beta.109, #54 |
| 기본 `tools/list` | 23 | 22 | 0.3.0-beta.106, #51 |
| 목록 카탈로그 | 130 | 50 | 0.3.0-beta.108, #53 |
| 4-C 참조 묶음, 문자 수 | 68,835 | 44,905 | 0.3.0-beta.110, #59 |
| 4-C 참조 묶음, 금지 표현 | 138 | 22 | 0.3.0-beta.110, #59 |

## 런타임 규칙

런타임 규칙은 사용자가 볼 수 있는 결과나 권한 경계를 보호할 때만 남습니다. 남은
규칙마다 좁은 범위, 코드가 강제하는 지점, 관찰할 수 있는 실패, 좁히거나 없앨 수
있는 조건이 있습니다.

### 유지되는 불변조건

| 불변조건 | 강제 지점 | 관찰 가능한 실패 | 축소 또는 제거 조건 |
| --- | --- | --- | --- |
| Canon, 증거, 후보, projection은 서로 분리된 채로 남음 | artifact 검증기와 명시적 ReviewDecision 전이 | digest 또는 권한 불일치, 승격되지 않은 후보 | 영향받는 artifact가 모두 한 권한 등급이 될 때만, 계획 없음 |
| 실행하거나 바꾸는 작업은 정확한 프로젝트와 소유한 프로세스 또는 경로에 묶임 | 프로젝트 fence, 호출자 fence, 안전 루트 검사, native supervisor | 시작 전 거절 또는 제한된 정리 영수증 | 읽기 전용 경로는 이미 실행 전용 fence를 생략 |
| 의미 식별자는 내용에서 파생되고 최신성을 확인할 수 있음 | 정규 해시, snapshot 포인터, 어댑터 검증 | 오래되었거나 변조된 식별자 거절 | 시간과 물리 어댑터 식별자는 이미 제외 |
| 자격 증명과 원시 제공자 transcript는 운영 데이터로 남고 정규 데이터가 아님 | 환경 필터, 제한된 임시 스트림, transcript 없는 영수증 | 비밀을 저장하지 않고 누락된 자격 증명을 보고 | 제공자가 자기 인증 저장소를 유지하는 동안 필요 없음 |
| Git, GraphDB, native 가속, 문서 호스트는 선택 사항이며 유일한 권한이 되지 않음 | 어댑터 계약과 다시 만들 수 있는 내장 artifact | 공개된 fallback 또는 어댑터 내부 실패 | 그 어댑터를 고르지 않으면 어댑터 검사도 사라짐 |
| 거절된 동작은 보고하고 다른 길로 다시 시도하지 않으며, 결과를 모르는 동작은 반복하지 않음 | 진입 문단, lease 소비 영수증, 최대 한 번 worker lease | 결과에 거절 또는 알 수 없는 결과가 나타남 | 계획 없음 |

### 위험 경로별 규칙

| 경로 | 유지되는 규칙 | 일부러 두지 않은 규칙 |
| --- | --- | --- |
| Observe | 제한된 읽기, 최신성, 권한 공개 | 기본으로 WholePlan, Capsule, Run, lease, 검토 없음 |
| Session | 정확한 요청 digest, 프로젝트 범위, 되돌릴 수 있는 로컬 동작, 제한된 일회성 lease와 결과 | ExecutionContract, 활성 Run, Product Canon 변경, Fresh Lode 검토 없음 |
| Run | 수락된 WholePlan, ExecutionContract, ContextCapsule, 정확한 Run, 제한된 실행기, ResultPacket, Fresh Lode 검토 | 제공자 세션 식별자 없음, 자동 Canon 승격 없음 |
| Authority | Run 통제와 영향받는 경계에서의 사용자의 명시적 결정 | 기능, 그래프 생성, 문서 편집, 모델 출력으로 암시되는 승인 없음 |

프로젝트 지침(루트 파일을 쓰거나 연결했을 때만 항상 읽힘)은 Run을 여는 때를 밝힙니다. 지속적인 소유, 중단 뒤 복구, 결과를
모르는 효과 추적, 중복 통합 방지가 필요할 때입니다. 그 밖에는 직접 작업합니다.

### 하위 시스템과 어댑터 규칙

- 초기화만으로는 Product 온보딩, 저장소 색인, Graph, Capsule, ReviewDecision이
  필요하지 않습니다. 기본은 `core` 프로필이며, 온보딩은 `product` 프로필을
  명시적으로 골라야 합니다.
- 온보딩만 Product Canon 부트스트랩 전에 증거가 연결된 후보와 명시적 일괄
  ReviewDecision을 요구합니다.
- Graph와 문서 어댑터만 재구축 가능성, snapshot 일치, 오래됨과 변조 거절, 승격 권한
  없음을 요구합니다.
- Native 계산만 manifest 무결성과 JavaScript 기준 구현과 같은 결과를 요구합니다.
  없을 때는 JavaScript fallback을 공개합니다.
- 배포만 소유 경로, 변경 불가 릴리스 식별자, 검증된 native 패키지, 복구 가능한
  포인터 변경, 프로젝트 상태 보존을 요구합니다.
- Codex만 고정된 `exec` 옵션과 이식 가능한 출력 스키마를 요구합니다. OpenCode만
  `run --format json --pure`, 권한과 개인정보 overlay, 이벤트 codec을 요구합니다.
  사용자의 OpenCode 제공자 설정과 인증이 계속 기준입니다.
- 검증된 호출자의 id 없는 저장은 서버가 그 호출자를 위해 메모리에 들고 있는 복구
  기준을 씁니다. 명시적 id, 검증되지 않은 호출자, CLI는 두 번 호출하는 저장을
  유지합니다.
- Windows Job Object와 POSIX 프로세스 그룹은 제공자 하위 프로세스를 정리하는 호스트
  로컬 방법입니다. 추가 의미 규칙이 아닙니다.

### 선택 기능

일반 제공자 세션 재개와 스트리밍, 더 넓은 프로세스 호스트 제어, 의존 작업의 자동
병합과 충돌 해결, Obsidian이나 Notion 게시, OpenAI 플러그인 디렉터리 게시는 선택
사항이며 만들지 않았습니다. 선택적 정확한 Lode 연결, 제한된 worker 소유와 대기,
같은 Project 대화 메시징(`lode_conversation_list`, `lode_conversation_send`),
정확히 소유한 일회성 중단과 종료는 동작하지만 범위가 정해져 있습니다. 이들 중
어느 것도 설치, 온보딩, 그래프 복구, Context, Session, Run, 제공자 교체, Git이나
GraphDB 없는 core 동작의 전제 조건이 아닙니다.

### 제거하거나 좁힌 규칙

- 작업이 더 이상 WholePlan, Capsule, Run, Fresh Lode를 거칠 필요가 없습니다. 위험
  경로가 그 비용을 맡습니다.
- Product, World, Graph 온보딩이 기본 초기화 경로에서 빠졌습니다.
- Git 커밋, 결정 표식, GraphDB 사용 가능 여부는 더 이상 의미 식별자, 복구, 온보딩의
  일부가 아닙니다.
- 제공자 세션 식별자는 더 이상 Project, Session, Run 식별자의 일부가 아닙니다.
- OpenCode 어댑터는 더 이상 자체 제공자 preset이나 endpoint 규칙을 갖지 않고,
  사용자가 확정한 설정을 읽습니다.
- 고정된 모델 호출 수는 성공 기준이 아닙니다.
- 역할 메일과 export 전달 장치는 제거했습니다. 대화 메시징은 Host의 살아 있는
  대화를 씁니다.
- 테스트는 더 이상 지침, 문서, Skill, 도구 설명의 문구를 고정하지
  않습니다(0.3.0-beta.107). 구조 검사는 남아 있습니다.
- 한 절차에만 해당하는 지침은 더 이상 항상 로드되지 않습니다(0.3.0-beta.109).
  Skill과 그 참조에 남아 있습니다.
- native Hook 도우미 `lode_session_host_request_prepare`는 더 이상 목록에 나오지
  않습니다(0.3.0-beta.106).

## 재지 않은 것

- 특정 Host가 기본 도구 목록 가운데 실제로 모델 앞에 놓는 양.
- 토큰 수. 모든 크기는 문자 수나 UTF-8 바이트입니다.
- 위임 호출 수를 스크립트로 재는 것, 그리고 글 크기가 모델 품질에 주는 영향.

## 결론

기본으로 항상 읽히는 지침 글은 측정 경로에서 3,700자이고 금지 표현은 4개입니다. 함께
전달되는 기본 도구 목록에는 31개가 있습니다. 남은 런타임 규칙은
권한 분리, 자격 증명과 개인정보 보호, 정확한 범위와 식별자, 복구 가능성, 프로세스
소유 가운데 하나에 대응합니다. 선택 어댑터는 범위 안에 머뭅니다. 새 필수 규칙을
제안할 때는 `node scripts/audit-metrics.mjs`를 다시 실행하고, 같은 변경에서 그
규칙의 강제 지점, 관찰 가능한 실패, 제거 조건을 밝힙니다.

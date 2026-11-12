> 이 문서는 [original-head-core-comparison.md](../original-head-core-comparison.md)의 한국어판입니다. 코드, 명령, 프로토콜 식별자와 필드 이름은 원문 표기를 유지합니다.

# 원본 HEAD Core 비교

비교일: 2026-11-12.

- Lode: `main` 커밋 `b85e14b` (0.3.0-beta.116).
- 원본: [`Won6314/head-agent-core`](https://github.com/Won6314/head-agent-core),
  커밋
  [`33d861458ab099dbcc22e49f329b628fbbba872b`](https://github.com/Won6314/head-agent-core/tree/33d861458ab099dbcc22e49f329b628fbbba872b)
  (2026-11-10). 얕은 clone에서 글로만 읽었습니다. 원본의 어떤 것도 설치하거나
  실행하지 않았습니다.

HEAD(옛 이름)는 이름을 바꾸기 전 Lode의 이름입니다. 이 문서는 원본에만 HEAD를
씁니다.

Lode는 원본에 묶여 있지 않습니다. 목표는 더 쓰기 쉬워지는 것입니다. 이 문서는
Lode가 더한 것과 그 이유, 그리고 두 쪽이 같은 결과에 다른 길로 가는 곳을 기록합니다.
차이는 한쪽의 설계 선택이며, 어느 쪽의 결함도 아닙니다.

## 지금의 원본

원본 저장소는 이제 Claude Code와 Codex용 플러그인 하나, `head-context` 0.9.7을
중심으로 합니다. 작업을 프로젝트 안의 평범한 파일로 남깁니다.

- 작업 세션은 목적 파일 `context.md`가 있는 폴더입니다.
- 그 안에서 이름 있는 작업 브랜치가 열리고 닫히며, 닫힌 브랜치는 하나의 메인
  기록으로 합쳐집니다.
- 저장할 때마다 `history.md`에 항목 하나가 붙고, 다음 단계를 적을 수 있습니다.
- `todo.md`가 나중에 할 일을 담습니다.

SessionStart hook은 HEAD Core 글, 작업 맥락, 그리고 `/clear`나 압축 뒤에는 직전
몇 번의 주고받기를 대화에 다시 넣습니다. 플러그인에는 MCP 도구 아홉 개(`list`,
`load`, `create`, `save`, `branch`, `read`, `todo`, `conversations`, `setup`)와
Codex의 `send`, 그리고 Skill 하나 `start-job`이 있습니다. 첫 실행은 core 글을 켜기
전에 사용자에게 묻습니다.

core 글인
[HEAD Core](https://github.com/Won6314/head-agent-core/blob/33d861458ab099dbcc22e49f329b628fbbba872b/packages/context/instructions/HEAD_CORE.md)는
맥락이 모델의 작업을 어떻게 만드는지(해상도, 좁아짐, 나무, 증거) 설명하고 일하는
원칙을 줍니다. 자세한 행동은 skill과 절차에, 금지는 검토 기준에 둔다고 말합니다.
다른 패키지에는 skill, 절차, worker 역할 core, 공유 런타임 코드가 있습니다. 이전의
설치형 호스트 daemon은 `packages/_platform/` 아래에 남아 있으며 릴리스에 들어가지
않습니다.

## 두 쪽이 함께 지키는 원칙

- 주도하는 agent가 전체 결과를 맡고, 결과를 바꾸는 선택은 사용자가 맡습니다.
- 자세한 작업 전에 문제를 합의합니다.
- 자세한 작업은 별도 맥락에서 하고 정리된 결과를 돌려받습니다.
- 요약이나 보고는 증거이지 새로운 합의가 아닙니다.
- 주변 검사를 더하기 전에 주 흐름을 실제로 돌립니다.
- 항상 로드되는 지침은 넓게 두고, 절차의 세부는 작업에 필요한 곳에 둡니다.

## 나란히 잰 값

Lode 값은 `node scripts/audit-metrics.mjs`에서 왔습니다([규칙 표면
감사](rule-surface-audit.md) 참고). 원본 값은 위 커밋에서 손으로 센 값이며, 방법은
마지막 열에 있습니다.

| 측정 | 원본 | Lode | 원본 측정 방법 |
| --- | --- | --- | --- |
| 세션마다 읽히는 core 글 | 6,909자(첫 실행 동의 뒤 HEAD Core) | 822자 진입 문단; 2,301자 프로젝트 지침은 루트 파일을 쓰거나 연결한 경우에만 | 커밋된 blob의 문자 수(`git show <commit>:packages/context/instructions/HEAD_CORE.md`, LF 줄바꿈) |
| MCP 서버 instructions | 공용 1,314자, 여기에 Claude Code 241자 또는 Codex 337자 | 822자 | 커밋된 `packages/context/core/mcp.mjs`의 템플릿 리터럴 값의 문자 수(이스케이프된 백틱은 한 글자로 셈, 실행하지 않고 글로 읽음) |
| Skill 목록의 Skill 설명 | Skill 1개, 76자 | Skill 3개, 969자 | 커밋된 `start-job` `description` 값의 문자 수 |
| 기본 도구 수 | 9(Codex는 10) | 22 | `packages/context/README.md`의 도구 표 |
| 저장 호출 수 | 1(`save`) | Host가 검증한 호출자 1, 그 밖에는 2 | 도구 표 |
| 재개 호출 수 | 시작 hook이 작업 세션을 불러오면 0, 아니면 1(`load`) | 연결된 Host 대화에서 0, 검증되지 않은 호출자나 새 Codex 스레드는 1(`lode_conversation_enter`), 새 Claude Code 대화는 Session이 하나면 1(`lode_conversation_enter`), 여럿이면 2(`lode_session_list` 다음 `lode_conversation_enter`) | README hook 절 |
| 위임 호출 수 | 플러그인 호출 0, Host의 fork나 agent 도구 사용 | 기본 경로에서 Lode 호출 0, managed 경로에서 4 + 4 | 서버 instructions |
| core 글의 금지 표현 | 3 | 진입 문단 1, 기본으로 항상 읽히는 글 전체 4 | 감사의 표현 목록; 원본의 서버 instructions와 Skill은 한국어라 영어 목록이 맞지 않음 |

## Lode가 더한 것과 이유

| 더한 것 | 이유 |
| --- | --- |
| Claude Code, Codex, OpenCode 어댑터와 같은 CLI 및 MCP 표면을 가진 하나의 제공자 중립 core | 같은 프로젝트와 기록을 세 호스트 어디서나 쓰고, 호스트를 바꿔도 프로젝트 의미를 잃지 않습니다. [runtime 어댑터](runtime-adapters.md) 참고. |
| 내용 주소 기반 Project, Session, Run, checkpoint 기록과 저장 때의 복구 기준 검사 | 압축, `/clear`, 호스트 변경 뒤의 복구가 무엇을 되살리는지 확인할 수 있고, 두 작성자가 서로의 방향을 몰래 덮어쓰지 못합니다. [Session 복구](session-recovery.md) 참고. |
| Host가 검증한 호출자의 한 번 호출 저장 | 모델에게 추가 읽기를 요구하지 않고 충돌 검사를 유지합니다. |
| 다시 만들 수 있는 내장 프로젝트 그래프와 선택적 GraphDB 및 문서 projection | 데이터베이스나 문서 호스트를 원본으로 삼지 않고 코드와 기록을 찾습니다. |
| managed 실행: 승인, 최대 한 번 lease, native 프로세스 supervisor, 제한된 worker, 하나의 통합 흐름 | 지속적인 소유, 중단 뒤 복구, 알 수 없는 효과 추적이 필요한 작업에 계약이 있습니다. 일반 위임은 Host에 남습니다. |
| 증거가 연결된 후보와 명시적 검토를 갖춘 선택적 Product 온보딩 | Product 의미는 사용자의 결정으로만 바뀌고 모델 추론으로는 바뀌지 않습니다. |
| 명시적 전달 결과를 주는 같은 Project 대화 목록과 메시징 | 보낸 쪽이 메시지가 전달, 대기, 알 수 없음, 거절 중 무엇인지 알고, 알 수 없는 인계는 다시 보내지 않습니다. [대화 메시징](conversation-messaging.md) 참고. |
| marketplace 패키지, Windows, macOS, Linux 설치기, 선택적 native worker | 설치와 업데이트가 플랫폼마다 같은 방식으로 동작합니다. |

## 두 쪽이 다른 길을 가는 곳

- **작업 단위.** 원본은 이름 있는 작업 브랜치가 하나의 메인 기록으로 닫히는 작업
  세션을 씁니다. Lode는 작업 증거와 checkpoint를 기록하는 논리 Session을 쓰고,
  지속적인 소유, 중단 뒤 복구, 알 수 없는 효과, 중복 통합이 필요할 때만 Run을
  엽니다.
- **core 글.** 원본은 원칙 뒤의 맥락 이론을 가르치는 더 긴 글을 로드합니다. Lode는
  짧은 진입 문단을 로드하고, 절차의 세부는 필요할 때 읽는 Skill과 참조로 옮깁니다.
- **도구 표면.** 원본은 도구 아홉 개를 나열합니다. Lode는 기본 22개를 나열하고,
  discovery는 카탈로그 50개를 나열하며 그중 19개는 기본 목록에도 있습니다.
- **최근 대화.** `/clear`나 압축 뒤에 원본은 직전 다섯 번의 주고받기를 대화에 다시
  넣습니다. Lode는 기록된 방향과 사용자의 마지막 프롬프트에 대한 제한된 참조를
  되살립니다.
- **첫 실행.** 원본은 사용자에게 한 번 묻고 Claude Code의 기본 fork 설정을 포함한
  프로젝트 설정을 씁니다. Lode는 요청하지 않으면 루트 지침 파일을 쓰지 않고
  초기화합니다.

## 이전 비교

이 문서의 이전 판은 원본의 예전 모습과 Lode를 비교했습니다. 2026-08-20에 원본
작성자가 Lode 소스 `fd9ad3b`를 감사했고, 여러 차례 뒤에 반드시 고쳐야 할 사항은
없다고 확인했습니다. 2026-10-20에는 원본 경로를
[`ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa`](https://github.com/Won6314/head-agent-core/tree/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa)에서
다시 확인했습니다. 두 결과 모두 이름을 밝힌 커밋에만 적용됩니다. 이 문서는 비교
판정을 내리지 않습니다.

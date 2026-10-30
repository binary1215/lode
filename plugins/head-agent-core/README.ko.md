<p>
  <img src="docs/assets/branding/lode-readme-wordmark.png" alt="Lode Agent Core" width="720">
</p>

# Lode

[English](README.md) | **한국어** | [Documentation](docs/README.md) | [한국어 문서](docs/ko/README.md)

AI 대화가 바뀌어도 프로젝트의 방향과 변경 이유를 이어갑니다.

Codex, Claude Code, OpenCode에서 사용할 수 있습니다. 대화 압축 뒤에 저장된 작업을 복구하고, 지금 할 일에 필요한 맥락을 준비합니다.

[![Build](https://github.com/binary1215/lode/actions/workflows/go-worker-build-release.yml/badge.svg)](https://github.com/binary1215/lode/actions/workflows/go-worker-build-release.yml)
![Status](https://img.shields.io/badge/status-beta-blue)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![Runtime](https://img.shields.io/badge/runtime-Node.js%20%2B%20Go-00ADD8)

베타 버전입니다. [변경 이력](CHANGELOG.ko.md)과 [설치 안내](#설치)를 확인하세요.
로컬 `.lode` 기록은 플러그인 패키지에 포함하지 않습니다.

[첫 요청](#first-request) · [설치](#설치) · [일상적인 사용](#일반-사용자는-어떻게-사용하나요) · [복구](#recovery)

<details>
<summary>전체 목차</summary>

[왜 사용해야 하는가](#왜-사용해야-하는가) ·
[누구에게 필요한가](#누구에게-필요한가) ·
[일반 사용법](#일반-사용자는-어떻게-사용하나요) ·
[설치](#설치) ·
[고급 사용](#cli-자동화와-고급-설정) ·
[핵심 모델](#핵심-모델) ·
[그래프](#그래프와-기록) ·
[기능 현황](#기능-현황) ·
[문서](#문서)

</details>

## Lode Agent Core가 하는 일

Lode는 합의한 목표와 변경의 근거, 남은 할 일을 프로젝트 기록에 남깁니다. 다음 대화에서는 이전 채팅의 기억에 의존하지 않고 이 기록을 읽어 작업을 이어갈 수 있습니다.

Codex, Claude Code 또는 연동한 OpenCode에서 평소처럼 코딩 에이전트와 대화하면 됩니다. 별도 프로그램을 조작할 필요는 없습니다.

## 왜 사용해야 하는가

프로젝트가 한 번의 대화보다 오래 이어질수록 도움이 됩니다.

<a id="recovery"></a>

### 대화 압축이나 세션 손실 후에도 이어갑니다

저장한 목표, 결정, 진행 상황과 다음 단계에서 작업을 이어갑니다. 복구할 때는 현재 제약을 확인하며, 오래된 다음 단계보다 사용자의 새 요청이 우선합니다. 체크포인트는 의미 있는 변경이나 인수인계 때 남깁니다. 짧은 조사는 Run이나 체크포인트 없이 필요한 이유와 불확실성만 남길 수 있습니다. 어느 쪽이든 매 턴 기록을 만들 필요는 없습니다.

복구 범위는 기록된 작업 방향이므로 저장하지 않은 대화는 사라질 수 있습니다.
지원 Hook이 제공하는 제한된 prompt/final-response 참조는 인용된 P5 맥락이며,
전체 대화록이나 현재 사용자 승인의 증거가 아닙니다. Host별 지원은 [대화 압축 복구](docs/ko/compaction-recovery.md), [Session 복구](docs/ko/session-recovery.md), [작업 맥락과 Host 지원](docs/ko/session-work-context.md)을 참고하세요.

### 범위가 명확하고 검토 가능한 컨텍스트를 전달합니다

원하는 변경을 말하면 Lode가 저장소를 읽고 필요한 코드와 결정 근거를 고릅니다. 맥락 전달이 필요할 때 Context Compiler가 선택한 자료를 묶고 제외 내용과 불확실성을 알립니다. 단어가 일치한다는 이유만으로 관련성이 입증되지는 않습니다. 사용자가 근거 양식을 쓰거나 예산을 관리할 필요는 없으며, Compiler도 실제 포함 여부나 의미적 충분성을 인증하지 않습니다. [Context Compiler](docs/ko/context-compiler.md)에서 자세히 설명합니다.

### 무엇을 바꿨는지뿐 아니라 왜 바꿨는지 검토합니다

Git은 바뀐 내용을 보여줍니다. Lode는 의도한 결과, 허용 범위, 검증, 리뷰와 다음 단계도 남깁니다. 관리형 작업에서 워커의 결과는 스스로 승인이 되지 않으며, 독립 검토와 명시적 결정을 구분합니다. [실행 계보](docs/ko/execution-lineage.md)와 [ChangeSet](docs/ko/change-sets.md)을 참고하세요.

기록된 이유와 인용한 소스의 차이는 [기록 맥락 보기](docs/ko/context-lineage.md)로 확인하거나, Lode에게 로컬 읽기 전용 [Graph Explorer 스냅샷](docs/ko/graph-explorer.md)을 요청하세요. 인용이나 이웃 노드만으로 변경 원인이 입증되지는 않습니다.

### 제품 의도를 코드와 테스트에 연결합니다

검토한 제품 개념에서 파일·심볼·테스트까지 따라가고, 제안된 변경 영향을 살펴볼 수 있습니다. 추론한 의미는 사용자가 수용하기 전까지 후보로 남습니다. [Feature mapping](docs/ko/feature-mapping.md)을 참고하세요.

### 그 밖의 장점

선택 기능으로 Git·배포 근거, 제품별 관측, 정책과 코드의 차이, 측정값을 기록할 수 있습니다. 수집한 데이터가 스스로 제품 결정이 되지는 않으며, 커넥터가 없어도 일반 코딩은 계속할 수 있습니다. 분석 서비스나 운영 DB용 커넥터가 모두 기본 제공되지는 않습니다. [기능 현황](#기능-현황)과 [문서](#문서)에서 지원 범위를 확인하세요.

## 누구에게 필요한가

| 이런 작업을 한다면 | Lode가 돕는 부분 |
| --- | --- |
| 여러 AI 대화에 걸쳐 제품을 개발 | 매번 방향을 다시 설명하지 않고 이어갑니다. |
| 크거나 오래된 저장소를 유지보수 | 이전 결정까지 포함해 변경에 필요한 근거를 찾습니다. |
| 팀원이나 여러 워커와 협업 | 소유 범위·결과·검토를 구분하며 하나의 성과로 통합합니다. |
| Codex·Claude Code·OpenCode를 함께 사용 | 프로젝트 기록을 특정 provider 대화와 분리합니다. |

한 번 끝나는 스크립트나 대화 기록만으로 충분한 짧은 실험이라면 필요하지 않을 수 있습니다. Lode가 모델 출력을 자동으로 신뢰하게 해주는 것은 아니며, 그래프나 DB가 제품의 의미를 결정하지도 않습니다.

## 설치

Node.js 24 이상이 필요합니다. 현재 사용하는 클라이언트의 설치 명령을 선택하세요.

사용하는 도구의 설치 경로 하나를 선택하세요. Codex와 Claude Code 패키지는 대화형 Skill, MCP 서버, 지원 호스트용 검증된 네이티브 번들을 포함합니다. 실행 시에는 현재 호스트와 일치하는 바이너리만 사용합니다. OpenCode는 아래 프로젝트 설정을 따르며, 일반 대화에 CLI 설치가 필요한 것은 아닙니다.

[Codex에 설치](#codex-git-마켓플레이스) ·
[Claude Code에 설치](#claude-code-git-마켓플레이스) ·
[OpenCode 설정](#claude-code-및-opencode-프로젝트-프로젝션)

파일 설치, 선택한 프로젝트의 초기화·재개, 선택적인 지침 연결, 실제 Host 도구
로딩은 서로 다른 결과입니다. 에이전트는 확인한 범위를 구분해 설명합니다.
CLI 버전이나 생성 파일만으로 Host가 이를 읽었다고 보고하지 않습니다.
별도의 doctor·설정 확인 절차를 사용자가 반복할 필요는 없습니다.

신규 설치는 `lode-agent-core@lode-agent-plugin`을 사용합니다. 이미 HEAD를 쓰고 있다면 기존 설치를 계속 업데이트하면 됩니다. 두 번째 플러그인을 설치하거나 프로젝트 기록을 변환할 필요는 없습니다. MCP 서버의 이름은 `lode`입니다.

Host 권한이나 자동화가 `mcp__head_core__...` 또는 `mcp__lode_core__...`를
참조한다면 Core의 `head_*` 별칭으로 자동 전환되지 않습니다. 업데이트를
불러온 뒤 Host의 실제 MCP 도구 목록에서 `lode` 서버와 정확한 도구명을
확인하고, 사용자가 관리하는 규칙을 바꿀 때 그 이름을 사용하세요. 변경을
선택하기 전에는 기존 설정과 실행 중 연결을 보존하세요. 디스크 업데이트만으로
Host가 reload되지는 않습니다. 자세한 내용은 [MCP 이름 안내](#mcp-name-details)를
참고하세요.

### Codex Git 마켓플레이스

중간 베타는 검증된 마켓플레이스 게시로 배포하며 Git 태그는 별도 지정 릴리스에만
만듭니다. [변경 기록과 게시 정책](CHANGELOG.ko.md)을 참고하세요.

저장소는 `binary1215/lode`이며, Lode 마켓플레이스는 `lode-codex-marketplace`
브랜치에 게시됩니다. 이전 저장소 주소도 이곳으로 연결됩니다.

```powershell
codex plugin marketplace add binary1215/lode --ref lode-codex-marketplace
codex plugin add lode-agent-core@lode-agent-plugin
```

설치 후 Codex를 재시작하고, 설치된 Skill과 MCP 서버를 불러오도록 새 작업을
시작한 뒤 [첫 요청 예시](#first-request)에 원하는 작업을 넣어 요청하세요.

플러그인을 설치해도 프로젝트 초기화, GraphDB 접속, 모델 선택이나 Product
Canon 승인이 자동으로 이뤄지지는 않습니다. 해당 작업은 Core의 정해진 경계를
거치며, 중요한 변경에는 사용자의 명시적 검토가 필요합니다.

### Claude Code Git 마켓플레이스

```powershell
claude plugin marketplace add binary1215/lode@lode-claude-marketplace
claude plugin install lode-agent-core@lode-agent-plugin
```

설치 후 Claude Code를 재시작해 Skill과 `lode` MCP 서버를 불러온 뒤
[첫 요청 예시](#first-request)에 원하는 작업을 넣어 요청하세요.

Claude Code는 플러그인을 버전별 캐시에 복사하고 `${CLAUDE_PLUGIN_ROOT}`를
기준으로 MCP 진입점을 찾습니다. 소스 Core와 기존 Project 식별자는 유지합니다.
설치만으로 프로젝트 변경, Product Canon 검토, GraphDB 접속이나 모델 선택이
승인되지는 않습니다.

### Claude Code 및 OpenCode 프로젝트 프로젝션

아래 사용자 범위 설치를 쓰는 경우 OpenCode는 `--runtime opencode`, Claude Code는
`--runtime claude`, Codex는 `--runtime codex`로 선택한 클라이언트만 초기화합니다.
여러 통합을 원할 때만 쉼표로 조합합니다. 마켓플레이스로 설치한 Claude Code 사용자는 번들 Skill에 같은
초기화를 요청할 수 있습니다. 프로젝트에 해당 파일이 없을 때만 Claude Code용
`CLAUDE.md`, Codex용 `AGENTS.md`, OpenCode용 `opencode.json`을 만듭니다.
검증된 플러그인 MCP 연결이 있으면 중복 프로젝트 `.mcp.json`을 만들지 않습니다.
standalone Claude 초기화는 검증된 로컬 launcher나 정확한 절대 패키지 경로로
누락된 파일을 만들 수 있습니다. 기존 파일은 보존하고 직접 통합할 때 쓸 생성 파일은 선택된 정본 루트의
`.lode/generated/` 또는 기존 `.head/generated/`에 둡니다.

OpenCode 로컬 설정은 절대 Node 바이너리나 설치 경로 대신 `node`와
`{env:LODE_PLUGIN_ROOT}`를 기록합니다. Claude Code는 `${CLAUDE_PLUGIN_ROOT}`를,
Codex는 플러그인 상대 `.mcp.json`과 hook의 `${PLUGIN_ROOT}`를 사용합니다.
패키지 플러그인 없이 OpenCode를 시작할 때는 `LODE_PLUGIN_ROOT`를 Lode 설치
위치로 두세요. 패키지 플러그인은 관리 원본 설정의 hash와 현재 패키지 신원이
일치할 때만 빈 환경변수로 치환된 경로를 메모리에서 복구합니다. 사용자 소유이거나
수정된 설정을 가로채지는 않습니다.
설치 경로가 바뀌면 해당 PC에 Lode를 설치한 뒤 에이전트에게 기존 Project 재개를
요청하세요. 같은 정본 Project 경로에서는 Project·Session ID와 런타임 구성을
유지하며 호스트 설치 정체성을 갱신합니다. 패키지 실행 경로는 클라이언트 placeholder를 쓰며,
standalone Claude 경로는 해당 기기에 종속될 수 있습니다.
사용자 소유 `opencode.json`이나 `opencode.jsonc`는 그대로 두고,
필요한 연결을 확인할 생성본을 제공합니다. init·resume·status는 instructions와
MCP를 각각 로컬 설정됨·누락·비활성·충돌·여러 항목·미확인으로 구분합니다.
이미 충분한 AGENTS 연결이나 기존 서버 별칭은 중복 추가하지 않습니다.
설정 연결을 요청했다면 에이전트가 누락 항목만 연결하되 model·권한·다른 서버·지침
순서를 보존합니다. 비활성 상태나 다른 실행 설정은 변경이 필요한 경우에만 해당
선택을 확인합니다. JSONC·미해결 Host 환경변수·읽을 수 없는 파일은 미확인으로
남기며 자동으로 해석해 덮어쓰거나 일반 작업을 막지 않습니다. 이 결과는 로컬 파일
관측이며 실행 중인 OpenCode Host의 실제 로딩을 증명하지 않습니다.

Project 폴더 전체를 이동하거나 복사했다면 새 경로에서 명시적으로 재개하세요.
Lode는 보존된 소유 정보를 검증하고 Project·Session ID와 과거 기록을 유지합니다.
상태 조회만으로 새 위치를 채택하지 않으며, native Host 바인딩을 이전하거나 실행을
재생하지 않습니다. [Session 복구](docs/ko/session-recovery.md)를 참고하세요.
실행 중인 Host가 MCP 도구를 로드했는지는 별도로 확인하세요.

설정 중 지침 연결을 선택하면 기존 지침 파일의 원문을 보존하면서 작은 블록을
한 번만 덧붙일 수 있습니다. Claude Code에는 지침 파일 import를 사용하고,
Codex에는 프로젝트 지침을 읽도록 안내합니다. 거절하면 파일을 바꾸지 않으며
작업을 막거나 설정을 다시 제안하지 않습니다. 사용하는 Host의 설치 안내를
따르세요. 지침을 생성했다는 사실만으로 실행 중인 Host가 읽었다고 볼 수는 없습니다.

초기화 후 프로젝트에서 `claude`나 `opencode`를 시작하세요. 선택한 MCP 연결에 대한
Host의 승인 정책을 따릅니다. 검증된 플러그인 연결이 있으면 중복 프로젝트 서버를
추가할 필요가 없습니다. 런타임별
지시·설정 파일은 프로젝트 기록을 읽어 만든 결과입니다. 프로젝트 정본은 선택된
`.lode/` 또는 기존 `.head/` 하나로 유지됩니다.

### 사용자 범위 CLI

<details>
<summary>선택 사항인 사용자 범위 CLI 설치 보기</summary>

지원하는 런타임은 Node.js 24 이상이며 CI는 Node.js 24.18.0을 사용합니다.
Git 또는 다운로드한 소스 아카이브도 필요합니다.
대상 프로젝트 내부의 Git, Go, GraphDB, 공급자 런타임은 선택 사항입니다.

Windows PowerShell:

```powershell
git clone https://github.com/binary1215/lode.git lode
Set-Location .\lode
.\scripts\install.ps1 --native auto --project C:\path\to\project --runtime codex

lode-agent --version
```

macOS 또는 Linux:

```bash
git clone https://github.com/binary1215/lode.git lode
cd lode
./scripts/install.sh --native auto --project /path/to/project --runtime codex

lode-agent --version
```

설치 프로그램은 내용이 검증된 릴리스를 현재 사용자의 데이터 디렉터리에
준비하고 `~/.local/bin`에 실행 파일을 만듭니다. 명시적인 `--project` 초기화
단계 전에는 셸 프로필, Codex 캐시, 원격 GraphDB 또는 기존 프로젝트를
수정하지 않습니다.
위 예시는 Codex만 선택합니다. 해당 클라이언트에 맞게 `codex`를 `claude` 또는
`opencode`로 바꾸세요. `--version`은 실행 중인 CLI 버전이지 Host에 로딩된 도구의
증거가 아닙니다. status·doctor 진단은 필요한 경우에만 사용하면 됩니다.

</details>

<details>
<summary id="mcp-name-details">기존 HEAD 사용자: 설치 식별자와 MCP 이름 안내</summary>

신규 Lode 설치는 `lode-agent-core@lode-agent-plugin`, `lode_*`와 Lode Skill 이름을 사용합니다. 기존 `codex-marketplace`와 `claude-marketplace` 주소는 `head-agent-core@head-agent-plugin`, `head_*`와 기존 Skill 이름을 유지합니다. 각 패키지는 `lode` 서버 하나와 도구 이름 한 벌만 노출하며, 같은 구현을 사용합니다. 두 패키지를 함께 설치하지 말고 현재 사용하는 마켓플레이스를 유지하세요.

기존 HEAD 설치는 지금까지 쓰던 명령으로 업데이트합니다.

```powershell
codex plugin marketplace upgrade head-agent-plugin
codex plugin add head-agent-core@head-agent-plugin
```

```powershell
claude plugin marketplace update head-agent-plugin
claude plugin update head-agent-core@head-agent-plugin
```

기존 `.head/` 기록·ID·선택 Session은 그대로 유지하고 새 프로젝트는 `.lode/`를 사용합니다. 작업 별칭은 Host가 소유하는 `mcp__head_core__...`나 `mcp__lode_core__...` 이름을 자동 연결하지 않습니다. 디스크 업데이트가 실행 중 Host의 reload를 뜻하지는 않습니다. 사용자 소유 설정은 보존하고 생성된 대안에 새 서버명을 사용합니다. 검증된 롤백을 위해 과거 패키지의 원본 바이트와 서버명도 유지합니다.

</details>

<a id="first-request"></a>

## 첫 요청은 이렇게 해보세요

[플러그인을 설치하고 불러온 뒤](#설치) 프로젝트를 열고, 첫 요청에 실제 작업까지 함께 말하세요. 설정만 위한 별도 대화는 필요하지 않습니다.

```text
이 프로젝트에 Lode Agent Core를 사용해줘. 기존 상태가 있으면 이어서 재개하고,
없으면 Core를 초기화한 뒤 이 로그인 오류의 원인을 찾아서 수정해줘.
```

로그인 오류 대신 원하는 작업을 넣으면 됩니다. Lode는 초기화와 검증된 복구 뒤에도 그 작업을 이어가므로 같은 대화에서 계속 요청할 수 있습니다.

<details>
<summary>아직 설치하지 않았다면 에이전트에게 요청하세요</summary>

아직 설치하지 않았다면 코딩 에이전트에게 이 README와 함께 요청하세요.

```text
Codex에 Lode를 기존 공식 설치 경로로 설치해줘. 유효한 설치가 있으면 재사용하고,
프로젝트 지침과 현재 연결은 보존해줘. 직접 할 수 있는 절차는 수행하고,
내가 해야 할 부분만 알려줘. 그다음 이 프로젝트의 로그인 오류를 조사해줘.
```

Codex와 작업 내용을 사용하는 클라이언트와 목표로 바꾸면 됩니다. 이미 설치된
Skill 없이도 이 README에서 시작할 수 있습니다. 에이전트는 현재 권한으로 가능한
절차를 수행하고 결과를 확인한 뒤 원래 작업을 이어갑니다. Host 승인·로그인·수동
재시작은 사용자가 해야 할 수 있으며 앱을 임의로 재시작하지 않습니다.

</details>

## 일반 사용자는 어떻게 사용하나요?

[첫 요청 예시](#first-request)처럼 원하는 결과를 말하고, 이후에도 자연어로 작업을 요청하세요.

```text
이 변경에 필요한 코드와 결정 근거만 준비한 뒤 진행해줘.
```

```text
전체 계획은 하나로 유지하고, 서로 독립적인 부분만 워커로 나눠 병렬로 진행해줘.
```

Lode는 보통 직접 작업합니다. 위임이 도움이 되면 현재 도구의 워커에게 명확한 범위를 주고 결과를 확인해 통합합니다. 도구가 위임을 지원하지 않으면 직접 또는 순차로 진행합니다. 일반 위임에 관리형 Run, 워커 원장이나 추가 승인은 필요하지 않습니다.

이런 요청도 할 수 있습니다.

| 필요한 일 | 요청 예시 |
| --- | --- |
| 남은 작업에서 재개 | “저장된 Todo에서 이어서 진행하고, 아직 열린 일을 알려줘.” |
| 계획 갱신 | “구현과 검수 결과를 합치고, 새로 알게 된 사실에 맞춰 다음 계획을 조정해줘.” |
| 변경 이유 확인 | “이 변경의 기록된 이유와 당시 소스의 전후 차이를 보여줘.” |

모두 일반적인 요청입니다. 저장 양식이나 매 작업 검수 의식, 새로운 승인 단계를 추가하지 않습니다.

### 대화는 독립적으로, 방향은 함께 유지합니다

독립 작업은 각자의 작업 세션에서 진행하면서 프로젝트의 공통 목표와 현재 제약을 공유할 수 있습니다. 새 대화를 시작해도 다른 작업의 진행 상황은 유지됩니다. 사용자가 세션 ID를 관리하거나 경로 양식을 채울 필요는 없습니다. [그래프 탐색과 독립 Session](docs/ko/graph-discovery.md)을 참고하세요.

대화 압축이나 공급자 교체 뒤에는 대화 진입 시 저장된 작업 방향을 확인합니다. 사용자가 복구를 요청하거나 체크포인트 ID를 줄 필요는 없습니다.

복구는 저장된 기록을 사용하며 미저장 대화 전체의 보존을 보장하지 않습니다. 지원 Hook이 제공하는 제한된 prompt/final-response 참조는 인용된 맥락으로 활용할 수 있습니다. Host의 맥락 전달과 관리형 작업 재개는 지원 범위가 다릅니다. [작업 맥락과 Host 지원](docs/ko/session-work-context.md), [기능 현황](#기능-현황)을 확인하세요.

JSON을 쓰거나 GraphDB를 조작하거나 토큰 단계를 고르거나 MCP 호출을 결정할 필요는 없습니다. 제품 의미 승인, 모호한 범위 결정, 중요한 외부 변경처럼 실제 결정권이 사용자에게 있는 경우에만 Lode가 확인합니다. 일반 조사와 작은 승인된 수정에 별도 절차를 더하지 않습니다.

## 기능 현황

아래 상태는 소스 배포판의 구현 범위를 나타냅니다. 특정 Host에 설치해 실제 모델까지 검증했다는 뜻은 아닙니다. 저장된 맥락 전달은 미저장 대화 전체의 보존이나 관리형 자동 작업 재개를 보장하지 않습니다. 지원 Hook의 제한된 참조는 인용된 맥락으로 유지합니다.

<details>
<summary>구현·실험·미출시 기능</summary>

- 사용 가능: 현재 소스 배포판에 구현됨
- 실험적: 명시적이거나 제한된 활성화 경로 뒤에 구현됨
- 계획됨: 방향은 채택했지만 아직 배포되지 않음
- 보류됨: 현재 마일스톤 범위에서 의도적으로 제외됨

| 영역 | 기능 | 상태 |
| --- | --- | --- |
| 프로젝트 | 초기화, Source Scope, 검토를 거치는 Product Canon | 사용 가능 |
| 지식 | 원본 fallback을 갖는 제한된 그래프 우선 탐색, World Model, 증분 갱신, 선택적 Context Capsule | 사용 가능 |
| Session | 독립 논리 Session 라우팅, 공통 현재 방향과 정확한 기준의 갱신 | 사용 가능 |
| Session | 정확히 확인된 지원 Claude/OpenCode 자식의 상태 쓰기는 기본 보호, Codex 보호는 선택 적용 | 실험적 |
| 계보 | Run, ResultPacket, Fresh Lode 검토, P2 Session 및 대화 진입 복구 | 사용 가능 |
| Host lifecycle | 신뢰하는 Host 어댑터가 필요한 공급자 중립 compaction·최대 1회 continuation 계약 | 실험적 |
| Host context | compact를 포함한 Claude Code·Codex 패키지의 SessionStart 맥락 전달 | 사용 가능 |
| Host context | OpenCode V1 패키지의 요약·일반 모델 요청별 맥락 전달. 압축 직후 이벤트 아님 | 사용 가능 |
| Host context | Claude Code, Codex, OpenCode에서 compact와 clear 뒤 권한 없는 제한된 사용자 prompt 참조 | 사용 가능 |
| 런타임 | Claude Code, Codex, OpenCode 일회성 Session/Run 실행 | 사용 가능 |
| 런타임 증거 | 세 런타임 결정론적 fixture 및 로컬 CLI 기능 probe | 사용 가능 |
| 런타임 증거 | Claude Code 실제 모델 호출 적합성 | 실험적 |
| 릴리스 증거 | 공급자 중립 Git ref, deployment-result 및 release observation | 사용 가능 |
| 전달 증거 | 공급자 중립 환경/대상별 applied, failed, rollback 이력과 선택적 exact source-revision link | 사용 가능 |
| 공통 관측 | 기존 exact evidence 우선 준비, Host source 페이지 탐색, opaque ID 수집 | 사용 가능 |
| 제품 정책 | schema-v2 Policy proposal, 정확한 적용 대상과 semantic reference, user review, evidence-currentness 진단, revision 및 retirement lineage | 사용 가능 |
| 측정 | versioned metric definition, exact observation, condition-aware comparison, non-causal assessment 및 bounded lineage | 사용 가능 |
| 워커 | 범위가 제한된 전달, 대기, 결과, 검토, 통합 | 사용 가능 |
| 역할 통신 | 일반 Host 위임과 선택적인 정확한 엔드포인트 연결 | 사용 가능 |
| 프로젝션 | 로컬 그래프와 Markdown | 사용 가능 |
| 프로젝션 | ArcadeDB | 실험적 |
| 배포 | 사용자 범위 설치, 네이티브 전달, 롤백, 안전한 제거 | 사용 가능 |
| 배포 | 검증된 Git 기반 Codex 마켓플레이스 | 사용 가능 |
| 배포 | 검증된 Git 기반 Claude Code 마켓플레이스 | 사용 가능 |
| 배포 | Claude Code, Codex, OpenCode의 이식 가능한 MCP 실행 경로 | 사용 가능 |
| 배포 | OpenAI 범용 플러그인 디렉터리 | 계획됨 |
| 런타임 | 일반 공급자 세션 resume과 stream | 보류됨 |
| 문서 | Obsidian 및 Notion 어댑터 | 보류됨 |

정확한 주장과 승인 증거는 이 요약에서 추론하지 말고 하위 시스템 문서와
소스 검증을 사용하세요.

</details>

## 문서

| 필요한 일 | 읽을 곳 |
| --- | --- |
| 작업 시작 또는 설치 | [첫 요청](#first-request), [설치](#설치) |
| 저장한 작업 이어가기 | [복구](#recovery), [Host 지원](docs/ko/session-work-context.md) |
| 맥락이나 변경 이유 확인 | [Context Compiler](docs/ko/context-compiler.md), [Graph Explorer](docs/ko/graph-explorer.md) |
| 자동화 또는 연동 | [CLI](#cli-자동화와-고급-설정), [런타임 어댑터](docs/ko/runtime-adapters.md) |

변경 기여와 민감한 문제 신고는 [기여 안내](CONTRIBUTING.ko.md)와
[보안 안내](SECURITY.ko.md)를 참고하세요. 이 문서들은 배포·게시 권한을 부여하지 않습니다.

[전체 영문 문서 색인](docs/README.md)과 [전체 한국어 문서 색인](docs/ko/README.md)을
제공합니다. 모든 공개 영문 하위 시스템 문서에는 한국어 대응본이 있으며, 코드,
명령 이름, 프로토콜 식별자, 아티팩트 필드 이름은 두 언어에서 동일하게 유지합니다.

<details>
<summary>하위 시스템 안내</summary>

- [복구·Session 선택·World 최신성](docs/ko/recovery-state-separation.md): 저장된 방향, Session 경로와 파생 World 상태의 구분
- [아키텍처](docs/ko/architecture.md): 공급자 중립적 구성
- [권한 평면](docs/ko/authority-plane-contract.md): 실행 가능한 Graph/record 및
  권한 비증폭 계약
- [온보딩](docs/ko/onboarding.md): Lode semantic proposal, Core 검증과 명시적 검토
- [Context Compiler](docs/ko/context-compiler.md): 재현 가능한 작업 컨텍스트
- [작업 산출물 저장](docs/ko/artifact-storage.md): 추가 절차 없이 근거를 저장하고 찾는 방법
- [실행 계보](docs/ko/execution-lineage.md): 계획, 계약, 결과, 검토, 복구
- [World Model](docs/ko/world-model.md): 소스 증거와 그래프 구성
- [런타임 어댑터](docs/ko/runtime-adapters.md): 기능, 호출, 프로세스 소유권
- [성능 fast path](docs/ko/performance-fast-path-design.md): 의미 또는 권한을
  생략하지 않는 최적화

추가 참고 문서:

- [Product Model](docs/ko/product-model.md)
- [Product Operating Loop](docs/ko/product-operating-loop.md)
- [Release observation](docs/ko/release-observation.md)
- [공통 Observation 계약](docs/ko/observation-adapters.md)
- [전달 상태 관측](docs/ko/delivery-observation.md)
- [비차단 Conformance 재정](docs/ko/conformance-reconciliation.md)
- [증분 갱신](docs/ko/incremental-refresh.md)
- [컨텍스트 압축 복구](docs/ko/compaction-recovery.md)
- [Session 복구](docs/ko/session-recovery.md)
- [일반 Host 위임과 선택적 연결](docs/ko/role-coordination.md)
- [그래프 프로젝션 어댑터](docs/ko/graph-projection-adapter.md)
- [문서 프로젝션 어댑터](docs/ko/document-projection-adapter.md)
- [Codex 마켓플레이스 배포](docs/ko/codex-marketplace.md)
- [Claude Code 마켓플레이스 배포](docs/ko/claude-marketplace.md)

실제 동작은 런타임 계약, 대상 프로젝트의 사용자 소유 Canon, 현재 Session/Run
복구 상태와 명시적 ReviewDecision을 따릅니다. 저장소 개발 이력, 벤치마크
픽스처와 유지관리자 마일스톤은 플러그인 개발의 근거이며, 사용하는 프로젝트의
지시로 적용하지 않습니다.

</details>

## CLI, 자동화와 고급 설정

<a id="대화형-context-준비와-미리보기"></a>
<a id="대화-우선-경로"></a>
<a id="선택적-product-프로필-cli-경로"></a>
<a id="소스-범위"></a>

자동화에는 [Core 명령 참조](docs/ko/README.md#command-reference)를 참고하세요.

작업 맥락 예제는 [Context 준비](docs/ko/context-compiler.md#context-examples), 선택적 Product 설정은 [온보딩 예제](docs/ko/onboarding.md#product-cli-examples)를 참고하세요.

## 핵심 모델

<a id="아키텍처-개요"></a>
<a id="lode가-의미를-판단하고-compiler가-선택-맥락을-제공하는-컨텍스트"></a>
<a id="실행과-복구"></a>
<a id="제품-학습"></a>

[권한·맥락·복구 계약](docs/ko/architecture.md#detailed-core-model)를 참고하세요.

## 그래프와 기록

<a id="그래프와-기록의-경계"></a>
<a id="그래프-질의"></a>

[기록된 맥락·스냅샷·그래프 조회](docs/ko/context-lineage.md#graph-and-record-examples)를 참고하세요.

## 런타임과 역할 통신

[워커·어댑터·런타임 연결](docs/ko/architecture.md#runtime-coordination-reference)를 참고하세요.

## 선택적 GraphDB

[선택적 ArcadeDB 설정](docs/ko/architecture.md#optional-graphdb-reference)를 참고하세요.

## 설치 수명주기

공유 Project에서 물리 schema-2 스냅샷을 쓰기 전에 이를 읽을 모든 클라이언트를
업데이트하세요. Beta.69 이하는 이 형식을 변환하지 않고 거부합니다. 새 reader는
이전 저장 형식도 그대로 읽습니다. 플러그인 파일 업데이트가 실행 중인 Host나
MCP의 reload를 뜻하지는 않습니다. [저장 형식 호환성](docs/ko/snapshot-storage.md)을 참고하세요.

<details>
<summary>네이티브 전달, 업그레이드와 제거</summary>

### 네이티브 패키지

사용자 범위 설치와 업그레이드는 기본적으로 `--native auto`를 사용합니다.
설치 프로그램은 정확한 버전과 플랫폼 패키지를 선택하고 릴리스 체크섬,
아카이브 경로, 빌드 메타데이터, 네이티브 매니페스트를 검증한 뒤 바이너리를
릴리스 식별자에 포함합니다. JavaScript 전용 설치에는 `--native off`, 폴백을
허용할 수 없는 경우에는 `--native required`를 사용하세요.

Codex와 Claude 마켓플레이스 스냅샷에는 지원되는 다섯 타깃의 동일한 검증
패키지가 포함되므로 설치 중 별도 다운로드가 필요하지 않습니다. 타깃 누락,
서로 다른 빌드 커밋 혼합, 매니페스트 또는 다이제스트 불일치는 마켓플레이스
게시를 중단시킵니다.

네이티브 구성 요소는 무권한 계산, 소유 프로세스 감독, 읽기 전용 ArcadeDB
배치에 대해 서로 다른 계약을 가집니다. 어떤 구성 요소를 설치해도 Product
Canon, 그래프 식별자, 검토 권한 또는 계보는 변경되지 않습니다.

### 상태, 업그레이드, 롤백, 제거

새로 다운로드한 소스 트리에서 수명주기 명령을 실행합니다.

```powershell
node .\scripts\distribution.mjs upgrade
node .\scripts\distribution.mjs status
node .\scripts\distribution.mjs rollback
node .\scripts\distribution.mjs uninstall
```

업그레이드는 활성 포인터를 교체하기 전에 변경 불가능한 릴리스를 준비하고
검증합니다. 일반 제거는 실행 파일과 활성 포인터를 삭제하지만 복구를 위해
검증된 릴리스를 보존합니다. `uninstall --purge`는 사용자 범위 릴리스 저장소도
제거합니다. 어느 방식도 프로젝트의 `.lode` 상태, Git 데이터, 생성된 프로젝트
문서 또는 GraphDB 데이터를 순회하거나 삭제하지 않습니다.

공급자 설정과 인증은 Claude Code, Codex 또는 OpenCode가 계속 소유합니다.
Lode는 정확히 승인된 `provider/model`과 일시적인 권한·개인정보 오버레이만
전달합니다. 공급자 프리셋을 설치하거나, 자격 증명을 복사하거나,
엔드포인트를 다시 쓰지 않습니다.

</details>

## 설계 원칙

[설계 원칙](docs/ko/architecture.md#design-principles-reference)를 참고하세요.

## 소스에서 검증

[소스 검증과 근거의 한계](docs/ko/verification-evidence.md#source-verification)를 참고하세요.

## 상태와 라이선스

Lode Agent Core Plugin은 베타 소프트웨어입니다. 공급자 중립 헌법 Core, 복구,
Context Compiler, 실행 계보, 로컬 프로젝션, bounded worker, 검증된 Codex/Claude
배포는 더 넓은 사용자의 테스트를 받을 준비가 됐습니다. 위 표에서 실험적,
계획됨 또는 보류됨으로 표시한 기능은 이 베타 판정의 범위에 포함되지 않습니다.

이 프로젝트는 [MIT License](LICENSE)로 배포됩니다.
네이티브 바이너리에는 [Go 런타임·표준 라이브러리 고지](native/GO-NOTICES.txt)도 동봉됩니다.

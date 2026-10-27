> 영어 원문: [claude-marketplace.md](../claude-marketplace.md)

# Claude Code 마켓플레이스 배포

이 배포 평면을 변경하기 전에 [`architecture.md`](architecture.md)와
[`authority-plane-contract.md`](authority-plane-contract.md)를 읽으세요. Claude Code
패키징은 새로운 의미 또는 권위 평면이 아니라 공급자 중립적 Core의 투영입니다.

## 목적

CI는 통합 계약 제품군과 네이티브 빌드 매트릭스가 통과한 뒤 별도의 생성
`lode-claude-marketplace` 브랜치를 만듭니다. 소스 저장소는 직접 실행 가능한 Core로
유지되며, Claude 전용 카탈로그와 캐시 경로 세부 정보는 `.head/`, Product Canon,
Session/Run 계보 또는 런타임 권한 부여에 들어가지 않습니다.

기본 Lode 배포판에는 정확히 다음 항목이 포함됩니다.

```text
.claude-plugin/marketplace.json
.gitattributes
.lode-agent-claude-marketplace-generated.json
plugins/lode-agent-core/.claude-plugin/plugin.json
plugins/lode-agent-core/.lode-source-distribution-manifest.json
plugins/lode-agent-core/<allowlisted distribution files>
```

빌더는 Codex 마켓플레이스에서 사용하는 것과 동일한 불변 사용자 배포 허용 목록을
먼저 준비하고 검증합니다. Git 메타데이터, 테스트, 개발 전용 목표와 fixture, 로컬
빌드 출력, 임시 트리, 캐시 및 자격 증명은 제외됩니다. 이어서 CI는 정확히 다섯 개의
검증된 빌드 매트릭스 대상을 덧씌웁니다. 각 대상은 동일한 플러그인 버전과 소스
커밋을 공유하고 worker, supervisor 및 읽기 전용 ArcadeDB bridge 무결성 계약을
통과해야 합니다. 모든 네이티브 바이트를 포함한 원래의 검증된 매니페스트는 소스
릴리스 계보를 바인딩하기 위해 `.lode-source-distribution-manifest.json`으로
보존됩니다.

Claude Code는 설치된 플러그인을 버전이 지정된 캐시에 복사하므로, 상대 프로세스
경로는 플러그인이 아닌 호출자를 기준으로 해석될 수 있습니다. 생성된 Claude
스냅샷에서만 `.mcp.json`은 다음과 같이 투영됩니다.

```json
{
  "mcpServers": {
    "lode": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-plugin-server.mjs"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}"
    }
  }
}
```

투영되지 않은 모든 파일은 검증된 소스 배포와 바이트 단위로 동일하게 유지되어야
합니다. 생성된 마커는 마켓플레이스와 플러그인 정체성, 소스 릴리스, 저장소, 정확한
소스 커밋 및 최종 투영 바이트 전체의 다이제스트를 바인딩합니다. 검증기는 추가
파일이나 디렉터리, 심볼릭 링크, 경로 이탈, 소스 파일 드리프트, 투영 드리프트 및
정체성 불일치를 거부합니다.

## 설치

요구 사항: Claude Code와 최신 Node.js LTS 릴리스.

```powershell
claude plugin marketplace add binary1215/lode@lode-claude-marketplace
claude plugin install lode-agent-core@lode-agent-plugin
```

HEAD 호환 패키지도 서버명은 `lode`입니다. `mcp__head_core__...` 또는
`mcp__lode_core__...`에 연결된 Host 권한과 자동화는 내부 `head_*` 작업
별칭으로 자동 전환되지 않습니다. 업데이트를 불러오기로 선택할 때 Host의
연결된 MCP 도구 목록을 확인하고, 사용자 규칙을 바꿀 때 `lode`에 실제 노출된
정확한 이름을 사용하세요. 그전까지 기존 설정과 실행 중 연결은 보존하세요.
서버명을 바꾸려고 캐시된 플러그인이나 과거 롤백 패키지를 고치지 마세요.
디스크 업데이트만으로 Host가 reload되지는 않습니다.

설치 후 새 Claude Code 세션을 시작하세요. 일반 사용은 번들
`lode-agent-core` Skill과 typed `lode` MCP 작업을 통해 시작합니다.
설치만으로 `.lode/`나 `.head/`를 생성하거나, 프로젝트를 수정하거나, GraphDB에 연결하거나,
공급자/모델을 선택하거나, Product Canon을 승인하거나, ReviewDecision을 생성하지
않습니다.

버전이 지정된 Claude 캐시는 다섯 개 플랫폼 패키지를 모두 받지만, 런타임은 정확히
현재 호스트에 해당하는 디렉터리만 선택합니다. 설치 시 릴리스 다운로드는 필요하지
않습니다. 네이티브 구성 요소는 권위 없는 계산 및 전송 투영으로 남고, JavaScript
Core가 계속 의미 검증, 계보 및 모든 중대한 게이트를 소유합니다.

## 업그레이드 및 제거

```powershell
claude plugin marketplace update lode-agent-plugin
claude plugin update lode-agent-core@lode-agent-plugin
```

```powershell
claude plugin uninstall lode-agent-core@lode-agent-plugin
claude plugin marketplace remove lode-agent-plugin
```

플러그인을 제거해도 프로젝트 소유 상태나 Lode가 관리하는 프로젝트 상태는 삭제되지
않습니다. 프로젝트 `.head/` 제거는 별도의 명시적 사용자 작업으로 남습니다.

## 게시 소유권

CI는 `lode-claude-marketplace`와 기존 `claude-marketplace` 브랜치를 각각 정확한
마켓플레이스 식별자로 검증한 뒤에만 교체합니다. 검증된 브랜치는
정확한 이전 tip을 대상으로 force-with-lease를 사용하여 orphan commit에서
게시됩니다. 소유권 증거가 없거나, 브랜치가 동시에 이동했거나, 이전 스냅샷이
유효하지 않으면 게시가 중단됩니다. 과거 소유권 예외는 HEAD 호환 브랜치에만
적용되며 새 Lode 주소에는 적용하지 않습니다.

생성된 `.gitattributes`의 내용은 정확히 `* -text`이며, 체크아웃 시 개행을 다시
써서 운영체제 간 바이트 정체성이 무효화되는 일을 방지합니다.

## 검증

```powershell
npm run verify:distribution
npm run verify:claude-marketplace
node scripts/build-claude-marketplace.mjs --output C:\temporary\lode-agent-claude-marketplace
claude plugin validate C:\temporary\lode-agent-claude-marketplace
```

게시자는 추가로 `--native-root`를 사용하여 빌드하고 `--require-native`로 검증합니다.
소스 전용 로컬 스냅샷은 이 게시 게이트를 충족할 수 없습니다.

격리된 설치 테스트에서는 로컬 생성 마켓플레이스를 추가하기 전에
`CLAUDE_CONFIG_DIR`을 새 임시 디렉터리로 설정하세요. 이렇게 하면 마켓플레이스,
캐시 및 플러그인 상태가 사용자의 일반 Claude 구성 밖에 유지됩니다.

이 저장소는 공식 Anthropic 마켓플레이스가 아닙니다. Git으로 호스팅되는 타사
Claude Code 마켓플레이스이며 [MIT License](../../LICENSE)에 따라 배포됩니다.

## 정식 배포와 기존 설치 호환 구성

정식 소스 배포판은 플러그인 `lode-agent-core`, 서버 `lode`, 도구 `lode_*`와
Skill `lode-agent-core`, `lode-agent-onboarding`, `lode-conversation`을 노출합니다.
기존 `claude-marketplace` 브랜치는 호환 배포판의 플러그인
`head-agent-core@head-agent-plugin`, 서버 `lode`, 도구 `head_*`, Skill
`head-agent-core`, `head-agent-onboarding`, `head-conversation`을 설명합니다. 둘은 같은
Lode 구현과 검증을 사용하며, 각 배포판은 자기 이름 한 벌만 노출합니다. 소스 패키징은
실제 게시·설치나 실행 중 Host 동작의 검증이 아닙니다. 각 카탈로그는 플러그인 하나만
포함하며, 기존 설치를 자동 전환하거나 이중 등록하지 않습니다.

### 기존 HEAD 설치

기존 `binary1215/lode@claude-marketplace` 주소와 업데이트 명령을 유지하세요.
마켓플레이스를 다시 등록하거나 Lode를 재설치하거나 두 번째 플러그인을 추가할
필요는 없습니다.

```powershell
claude plugin marketplace update head-agent-plugin
claude plugin update head-agent-core@head-agent-plugin
```

제거 명령도 `claude plugin uninstall head-agent-core@head-agent-plugin`과
`claude plugin marketplace remove head-agent-plugin`을 유지합니다. 호환 스냅샷은
`.head-agent-claude-marketplace-generated.json`, `plugins/head-agent-core/`,
`.head-source-distribution-manifest.json`을 사용하며, 과거 스냅샷과 롤백은 원래 식별자와
바이트를 보존합니다.

새 초기화는 `.lode/`를 사용합니다. 기존 `.head/` Project는 root·식별자·원문·선택
Session과 운영 소유권을 유지하며, 수동 변환이나 두 번째 정본 저장소가 필요하지 않습니다.

두 배포판 모두 MCP 서버를 `lode`로 등록하고 초기화합니다. Core는 정해진
`head_*`와 `lode_*` 작업 별칭을 인식하지만, 각 배포판은 자기 도구만 나열합니다.
이 별칭은 Host가 소유한 `mcp__head_core__...` 또는 `mcp__lode_core__...`
이름 공간을 자동 연결하지 않습니다. 이전 Host가 실행 중이면 기존 연결을 유지하며,
디스크 업데이트가 reload나 새 Host 도구 목록의 검증을 뜻하지는 않습니다.
사용자 소유 `.mcp.json`과 `opencode.json`은 보존하고, 생성된 대안에 새 서버명을
사용합니다. 과거 릴리스 검증과 롤백은 기존 패키지를 다시 쓰지 않고 원본 manifest,
당시의 정확한 서버명, 기록과 checksum을 유지합니다.


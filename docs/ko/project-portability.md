> 영어 원문: [project-portability.md](../project-portability.md)

# Project와 선택한 기록 옮기기

“이 폴더에서 기존 Project 작업을 이어가자”, “이 대화의 작업을 다른 PC에서 이어갈 수
있게 내보내 줘”라고 요청합니다. Lode는 합의한 방향, 현재 공통 제약, 선택한 Session의
기록과 그 근거 원본을 옮깁니다. Product 온보딩, World 재구축, Run, 별도의 저장·승인
절차를 선행 조건으로 요구하지 않습니다.

## 폴더를 복사한 경우

일반 `resume`은 기존 Project의 위치 계보를 검증합니다. 최초 위치를 증명할 수 없는
구형 사본은, 최초 출처가 미확인임을 설명한 뒤 해당 사본에 대해 명시적으로 선택한
`copied_project: "verified-copy"` 초기화·재개 경로를 사용할 수 있습니다. 같은 옛 경로나
Project ID가 있는 모든 파일을 신뢰한다는 뜻은 아닙니다.

수용한 원본 중 바뀌지 않은 것만 계속 읽습니다. 나중에 추가하거나 바꾼 옛 경로의
기록은 그 증명을 빌릴 수 없습니다. 과거 실행 authorization·lease·공급자 연결·현재
실행 권한은 이전하지 않습니다. 이후 정상적인 checkpoint·Run 변경은 검증된 현재
소유자를 사용합니다.

알려진 텍스트 파일이 LF/CRLF 변환으로만 달라졌고, 기존에 기록된 digest를 정확히
재현할 수 있으면 복구할 수 있습니다. 관측한 변경 전 원문을 보관하고 파일별로 적용
직전의 before/after를 확인합니다. BOM 제거, 과거 경로 치환, 임의 JSON 수정이나
변경된 내용을 받아들이기 위한 재해시는 하지 않습니다. 중단 후 확인 가능한 게시이지,
모든 파일을 한꺼번에 바꾸는 원자적 트랜잭션은 아닙니다.

## 선택한 기록을 번들로 옮기기

인자는 에이전트가 작성합니다. 사용자가 JSON이나 ID 목록을 직접 만들 필요는 없습니다.
플러그인 폴더에서 사용할 수 있는 고급 CLI는 다음과 같습니다.

```sh
node scripts/lode.mjs project-export "<project>" --destination "<new-bundle-folder>" --session "<selected-logical-session>"
node scripts/lode.mjs project-bundle-inspect "<bundle-folder>"
node scripts/lode.mjs project-import "<target-project>" --bundle "<bundle-folder>"
```

동일한 typed 도구는 `lode_project_bundle_export`, `lode_project_bundle_read`,
`lode_project_bundle_import`입니다. 공통 방향, 선택한 P2·Canon·참조의 정확한 원본과
작업 근거를 담습니다. 다른 Session의 본문, 캐시, 루트 통합 설정, 인증 정보, 살아 있는
lease와 네이티브 연결은 제외합니다. 저장소 작업 파일이나 첨부도 이 작업으로 복사하지
않습니다. 누락한 자료가 필요한 경우 번들뿐 아니라 원래 프로젝트 작업 파일·첨부 또는
별도로 검증한 사본도 함께 보관합니다.

구형 사본의 일부 채택 증명에는 다른 Session의 경로·ID·해시 메타데이터가 들어 있습니다.
기본값인 `provenance_scope: "project-proof-metadata"`는 복구에 필요한 원래 공통 증명
메타데이터만 포함하며, 다른 Session 본문은 제외합니다. Lode는 내보내기를 호출하기 전에
이 범위를 대화로 알립니다. CLI와 stdio MCP도 대상 폴더 생성·첫 복사 전에 범위 안내를
내보냅니다. stdout JSON과 원래 manifest·증명 바이트는 그대로 역할을 유지합니다.
안내는 P4 정보이며, 읽었다는 수신 증명·승인·권한이 아닙니다. 추가 승인 토큰이나
plan·save·bind 절차를 만들지 않습니다.

명시적인 `provenance_scope: "selected-only"` 또는 CLI `--provenance selected-only`는
다른 Session을 언급하는 증명 목록을 제외합니다. 필요한 구형 증명이 빠지면 부분 상태로
표시하고, 빠진 증명을 고쳐 채택을 통과시키지 않습니다. 불완전한 출처 증명은 그 증명에
의존하는 채택만 제한하며, 보관한 선택 원본 조회와 독립적인 일반 작업은 계속합니다.
코드 호출자는 선택적 동기 `onExportScope` Host 콜백을 사용할 수 있으며 콜백이 없어도
raw API를 사용할 수 있습니다. 반환되는 `exportScope`는 저장되지 않는 투영이며,
번들 원본이나 사용자가 안내를 읽었다는 기록으로 승격되지 않습니다.

가져오기는 기본 Session을 바꾸지 않습니다. 같은 Project가 이미 있으면 아직 없는
정확한 선택 Session만 추가하고, 대상의 더 새로운 공통 방향·지식·취소를 유지합니다.
설치 투영은 대상의 현재 설치에서 생성하며, 사용자의 통합 파일·모델·권한 설정은
보존합니다. 반환된 정확한 Session 경로로 이어갑니다. 같은 파일은 재사용하고, 소유가
확인된 미완료 게시만 이어가며, 제3의 상태는 충돌로 보존합니다. 완료했거나 결과가
불확실한 효과를 다시 실행하지 않습니다.

## 보관 원문과 정확한 과거 diff

기본 내보내기는 선택한 Session의 작업 근거가 정확히 인용한, 이미 Lode에 보관된
적격 파일 원문을 포함합니다. 호출 전에 이 범위를 알리며 SourceObservation의 원래
바이트를 그대로 복사합니다. 파일 SHA-256, bundleKey, observation ID·hash는 서로
구별해 보존합니다. 현재 작업 파일 전체·다른 Session 본문·Git의 새 원문 수집은
포함하지 않습니다. 소스·호출 관계·선언의 알려진 형식에는 내보내기 전용 필드 검사를
추가합니다. 모든 깊이와 구조 응답 JSON 내부의 중복 키·이스케이프된 동일 키도
검출합니다. 알 수 없는 profile이나 추가 필드는 원본을 고치지 않고 제외합니다. 일반
원문 조회의 형식을 제한하는 검사는 아닙니다. 해시는 바이트 동일성만 증명하므로 선택
파일의 민감 정보나 생산자 주장의 진실성까지 검증됐다고 하지 않습니다. 공유 전에
포함 범위를 확인합니다.

원문 없이 참조만 옮기려면 대화로 요청하거나 `--sources refs-only`, typed MCP의
`source_mode: "refs-only"`를 사용합니다. 누락·미지원·조회 불가 원문은 범위 안내,
manifest, Handoff, 가져오기 결과에서 참조별 이유로 표시하고 일반 Session 복구는
계속합니다. 확인하지 못한 바이트수는 알 수 없음으로 남깁니다. 내보내기는 로컬 Git을
조회해 누락 원문을 분류하지 않습니다. 기존 조회의 제한된 로컬 Git fallback은 유지하며
그때 찾은 근거와 이관한 원문을 구별합니다. Git 전용 원문 수집은 후속 범위입니다.

새 Project와 기존 동일 Project의 Session 가져오기 모두 원문을 공통 불변 저장 경로에
설치합니다. 검증된 채택·Session 영수증의 정확한 연결로 원문을 직접 찾아, 무관한 보관
번들이 많아도 같은 diff를 읽게 합니다. 원 PC와 작업 파일이 없어도 복구 후 CLI·MCP·
Explorer에서 보관된 두 인용 버전을 비교하며 재내보내기에도 이 연결을 유지합니다.
복사됨·원본 검증됨과 실제 diff 조회 성공은 별도 결과이며 없는 쌍은 부분 상태입니다.

이미 포함 원문을 확정한 manifest의 가져오기는 정확히 수행해야 합니다. 대상 원문이
다르면 조용히 생략해 성공시키지 않고 충돌·미완료로 남깁니다. 대상의 기존 일반 작업은
계속할 수 있습니다. 같은 중단 작업의 재시도는 동일 원본과 영수증을 재사용하고 다른
바이트는 덮어쓰지 않습니다. 참조만 이관하려면 별도로 명시해 새 번들을 만듭니다.

원문 증거 형식은 유지하며 새 portable manifest는 schema 2와
`portable-selected-retained-sources-v1` 기능을 사용합니다. 복구·재이관의 채택·소유 증명
경로도 이를 검사합니다. 새 reader는 schema 1 번들도 읽되 원문 이관은 기록 없음·미검증으로
표시합니다. 구형 reader는 schema 2를 쓰기 전에 거부합니다. 이는 해당 가져오기의
호환성 경계이며 기존 기록이나 일반 작업을 차단하지 않습니다. 원문 증명과 coverage는
P2 방향·승인·실행 권한을 만들지 않습니다.

## 선택적 Codex 네이티브 이력

이 기능은 별도의 실험적 Host 어댑터이며 **Codex의 안정적인 공식 import API가
아닙니다.** 일반 Project·Session 복구는 독립적으로 사용할 수 있습니다. 첫 검증 조합은
Windows x64·Codex 엔진 `0.166.0-alpha.5.1`이며, DB 스키마·마이그레이션·원본 이력
형식을 정확히 검사합니다. 버전 문자열만 같다고 지원하지 않습니다. 모르는 네이티브
조합에서도 공통 번들의 보관·조회는 가능하지만, 네이티브 쓰기를 지원한다고 하지 않습니다.

공개 작업은 `lode_project_native_history`이며 CLI는 다음과 같습니다.

```sh
node scripts/lode.mjs project-native-history "<bundle>" --action capture --provider codex --native-home "<source-CODEX_HOME>" --executable "<exact-codex.exe>" --threads "<explicit-native-id,...>"
node scripts/lode.mjs project-native-history "<bundle>" --action read
node scripts/lode.mjs project-native-history "<bundle>" --action restore --native-home "<target-CODEX_HOME>" --executable "<exact-codex.exe>"
node scripts/lode.mjs project-native-history "<bundle>" --action register --native-home "<target-CODEX_HOME>" --executable "<exact-codex.exe>" --runtime-root "<current-workspace>"
```

capture에는 `provider`(`codex`, `claude`, `opencode`)가 필수입니다. 에이전트가
요청된 출발 플랫폼이나 검증된 Host 경로에서 공급하며, 사용자에게 ID나 JSON 작성을
요구하지 않습니다. read·restore·register는 검증된 companion link에서 플랫폼을
가져올 수 있고, 명시한 provider가 있다면 link와 같아야 합니다. ID나 실행 파일 이름으로
플랫폼을 추정하지 않습니다. 현재 로컬 후보는 Claude 2.1.223과 OpenCode 1.19.5
어댑터도 연결합니다. 공식 버전·이력·스키마의 격리 검증 범위는 아래에 설명하며,
일반 앱과 모델 이어쓰기 지원 검증은 아직 미완료입니다. 실행 파일을
사용할 수 없으면 native home 접근이나 시작 전에 반환합니다. 지원이 확인되지 않은
조합은 해당 네이티브 작업에만 영향을 주며, 공통 복구와 Handoff는 계속 사용할 수 있습니다.
선택한 원문과 부속 자료는 비밀 제거 없이 보존합니다. 설정을 자동 수집하지 않는다는
사실이 선택한 내용에 비밀이 없음을 보증하지는 않습니다.
Claude 구조 검사에서는 파일명이나 메타데이터 행만으로 선택한 대화를 확인하지 않고,
메시지 행에서 선택한 session ID가 관측돼야 합니다. 분기의 조상 기록은 원문 그대로
보존하며, 선택한 조상 계보 밖의 다른 session 메시지와 ID 누락을 별도로 표시합니다.
이는 공식 클라이언트에서의 대화 소유 검증을 뜻하지 않습니다.

각각 별도로 요청하는 효과입니다. 일반 개발 전에 이 명령들을 순서대로 실행할 필요는
없습니다. 데이터 조회에는 기존 읽기 전용 `lode_project_bundle_read`의
`include_native_history: true`를 사용합니다. SDK를 시작하지 않으며, 공통 결과와 선택적
네이티브 오류를 분리해서 보여 줍니다.

Codex 어댑터의 캡처와 raw·SQLite 복원에는 쓰기 프로세스가 멈춘 창을 실제로 관측해야 합니다. Lode가
앱이나 기존 MCP 연결을 종료·재시작하지 않습니다. 관련 writer가 불명확하면 네이티브
작업만 사용할 수 없으며 Core 복구는 계속됩니다. 현재 대화가 자기 앱을 닫은 뒤 그대로
실행을 이어가는 구조는 아닙니다. 이관을 준비하고, 사용자가 선택한 오프라인 창에서
CLI로 진행합니다.

### Claude와 OpenCode 로컬 어댑터

선택한 대화를 같은 클라이언트로 옮겨 이력을 복원해 달라고 요청하면 됩니다.
에이전트가 출발지·대상·선택 범위를 확인하며, 내부 ID나 JSON을 직접 작성할 필요는
없습니다. 고급 CLI·MCP는 위 표면을 그대로 사용합니다. 두 provider의 capture·restore·register에는
`--runtime-root <source-or-target-project>` / `runtime_root`도 공급합니다.
읽기에는 번들만 있으면 됩니다.
OpenCode 출발지 수집에서는 현재 Host가 이미 선택된 정확 ID의 export capability를
제공해야 합니다. 출발 native-home·executable을 별도로 지정해 이 경로를 바꾸거나
일반 프로필의 폴더 구조를 추정하지 않습니다.

Claude capture는 선택한 JSONL의 안정된 스냅샷을 보존하며, 진행 중인 원본 대화가
끝났다고 주장하지 않습니다. 선택적인 `--companions` / `companion_paths`는 출발
프로젝트 이력 폴더의 `<native-id>/` 아래 파일만 지정하며 외부 참조를 따라가지 않습니다.
restore는 파일 충돌과 다른 프로젝트 폴더의 동일 ID를 먼저 검사하고, 쓰기 중지 창을
다시 관측한 뒤 없는 파일만 생성해 바이트를 재조회합니다. 같은 원문은 재쓰기 없이
확인하고 다른 내용은 보존합니다. 초기 writer 관측은 Windows native `claude.exe`를
지원 대상으로 삼으며 다른 조합은 아직 검증되지 않았습니다. 문서화된 경로 변환이
200자를 넘으면 검증된 공식 경로 해석이 필요하며 임의 해시를 만들지 않습니다.
이 제한은 네이티브 쓰기에만 적용됩니다. register는 이미 설치된 Agent SDK 0.3.234로
목록과 반환 메시지를 읽을 수 있으며 SDK가 없어도 원문 복원 결과는 독립적으로
사용할 수 있습니다. SDK 목록과 CLI picker 노출은 별개이고 모델 턴을 시작하지 않습니다.

OpenCode 출발지 수집은 현재 Host capability가 반환한 정확한 export 바이트를
보존하며, 해당 capability가 없으면 수집할 수 없습니다. 대상 복원에서는 선택한
대화 전체의 session·message·part를 단일 SQLite 트랜잭션으로 반영합니다.
충돌한 행을 덮어쓰거나 건너뛰지 않습니다. 과거 메시지와 파트의 JSON은 보존하며,
원본 export와 파생 입력의 digest를 구분합니다. 출발 Session Info의 활성
permission·model·agent·revert·workspace·compacting 값은 파생본에서 제외합니다.
prompt loop나 과거의 미완료 작업은 실행하지 않습니다.

현재 검증된 오프라인 어댑터는 공식 Windows x64 baseline OpenCode 1.19.5
바이너리의 바이트 수와 SHA-256을 대조합니다. 명시적으로 선택한 기존 격리 구조
`<native-home>/profile/data/opencode/opencode.db`, 검증된 스키마·마이그레이션 집합,
현재 대상 경로에 연결된 기존 Project가 필요합니다. DB를 자동 초기화·마이그레이션하거나
Project ID를 만들거나 일반 프로필로 전환하거나 클라이언트를 시작하지 않습니다.
지원되지 않는 조합은 해당 네이티브 작업에만 영향을 줍니다. 사용자 JSON이나
boolean으로 검증을 우회하지 않으며, 출발지 수집에는 여전히 현재 Host의 정확 ID
export capability가 필요합니다.

쓰기 전에 고정된 공식 소스에 근거한 검증기가 Session Info, User·Assistant 메시지,
알려진 Part 12종과 중첩된 tool·file 구조를 검사합니다. 알 수 없는 variant나 SQL
매핑으로 보존할 수 없는 Session 필드는 원문을 남긴 채 거절합니다. 공식 Effect
decoder를 실행했다는 의미는 아닙니다. 대상 경로와 공식 동작의 사용량 기본값·빈
share 정규화는 별도로 표시합니다. 전역 ID, 기존 부모 계보의 소유·순환, 스키마,
Project 및 물리 DB 동일성을 트랜잭션 안에서 다시 확인합니다. 메시지 SQL 정렬 키와
본문 시각이 다르면, 다시 정렬해 성공으로 숨기지 않습니다.

기본 OpenCode CLI의 전체 부트스트랩은 계속 사용할 수 없습니다
(`NATIVE_OPENCODE_BOOTSTRAP_UNQUALIFIED`). 오프라인 어댑터는 검증된 DB를
직접 읽으며 `import`·`export`·`session list`나 모델 명령을 실행하지 않습니다.
루트 대화 목록, 선택 ID의 정확한 본문 재조회, 실행 중인 앱 노출은 별개입니다.
읽기 프로세스는 공존할 수 있고 다른 writer가 있으면 신속히 알리며, 모든 앱의 종료를
요구하지 않습니다. WAL·SHM 동작까지 바이트 단위 불변이라고 주장하지 않습니다.

격리 시험에서는 공식 Claude Code 2.1.223 버전 출력, SDK 0.3.234의 합성 JSONL
목록·메시지 조회, 새 합성 DB에서 공식 OpenCode 1.19.5의 비인스턴스 `db` 명령을
실행했습니다. 설치 스크립트, 전역 프로필, 실사용 이력이나 모델 턴은 사용하지 않았습니다.
이 결과가 picker 노출, 일반 프로필 지원이나 모델 이어쓰기를 입증하지는 않습니다.
선택적 SDK의 이력 읽기는 함께 제공되는 Claude 백엔드를 시작하지 않습니다.

두 어댑터는 생성 전용 운영 시도·결과 기록을 남깁니다. 기록과 실제 파일 게시·SQLite
커밋이 원자적으로 묶이지 않으므로 중단이나 부분 효과는 원래 실패 원인·영향 범위와
함께 불확실한 상태로 남습니다. 이후 승인된 요청에서 현재 파일·ID를 정확히 재조회할
수 있지만 효과를 자동 재실행하지는 않습니다. 충돌한 원문은 덮어쓰지 않습니다.
원문·이력 검증, 목록 관측, 이어서 실행할 준비 여부를 분리하며 합성 시험의 성공으로
대상 모델·권한 준비나 실제 Claude·OpenCode 지원을 추론하지 않습니다.

Codex 캡처는 선택한 원본 바이트, 원래 파일명, 타입을 보존한 이력 행을 담습니다. 64비트 정수,
BLOB, NULL, 알 수 없는 JSON 필드도 보존합니다. SQLite가 읽는 commit된 WAL을 사용하며,
source WAL·SHM이나 source DB 전체를 전송하지 않습니다. 선택한 과거 state는 계정 선택
열을 제외한 역사적 근거이며, 대상 state 행이나 현재 권한 설정으로 적용하지 않습니다.
옛 절대경로도 역사적 정보로 남습니다. fork·history-base·압축·회전·보관 이력은 각각의
closure·형식 검증 한계를 유지합니다. 보존했다고 네이티브 복원이 검증된 것은 아닙니다.

모든 provider에서 create-only `native-history.json`은 정확한 공통 번들과 선택한 네이티브 payload를
연결합니다. P3 이관 근거이며, **이 Lode Session이 해당 네이티브 대화를 소유한다는
증명은 아닙니다.** 명시적인 선택이나 별도로 검증된 Host 경로를 사용하고 제목·최신
순서로 소유를 추정하지 않습니다. runtime binding·checkpoint·ReviewDecision·Canon·실행
권한을 만들지 않습니다. 연결 파일의 부재·부분 복사·손상은 네이티브 결과의 문제이며,
공통 manifest는 바뀌지 않습니다.

Codex 복원은 검증된 대상 이력 DB의 로컬 사전 백업 뒤, 없는 정확한 raw 파일과 선택한 이력
행만 추가합니다. state DB 교체, `INSERT OR REPLACE`, 이후 사용자의 변경을 전체 백업으로
덮어쓰기, 대상 설정 변경은 하지 않습니다. 파일 게시와 SQLite 트랜잭션은 별도 경계이며,
앱 시작이나 source·target의 변경이 감지되면 의존하는 후속 작업을 중단합니다.

Codex rollout 캡처는 디코더 한도를 넘는 큰 frame도 원문 바이트로 스트리밍해 보관합니다. 최종 바이트 길이가
선택한 cutoff와 같아야 하지만, 한도 이후의 frame 경계와 의존성은 미검증으로 남습니다.
캡처나 재조회가 이를 네이티브 게시 지원으로 승격하지 않습니다. ID·권한·잘못된 형식·
cutoff의 오류는 원래 실패를 유지합니다.

## 등록과 실제 검증 한계

이 절은 고정된 Codex SDK의 메타데이터 등록 수명주기와 로컬 SQLite 백업만 설명합니다.
Claude의 선택적 SDK 조회와 OpenCode의 Host·격리 프로필 흐름은 위에 설명한 별도의
효과와 한계를 가집니다. Codex 백업·정책 조회·등록의 보증을 두 provider에 적용하지 않습니다.

등록은 소유권을 확인하고 감독하는 SDK 메타데이터 수명주기를 시작합니다. **SDK 시작만으로
파일을 발견해 명시적인 resume 전에 메타데이터를 바꿀 수 있습니다.** 따라서 시작 전부터
저널에 기록하며, 읽기 전용 연결 점검으로 취급하지 않습니다. SDK 시작 전에 대상 native-home의 작업 디렉터리에 대상 state DB의 일관된 로컬 백업을
보관합니다. 실제 스키마·무결성과 기존 사용자 선택 필드를 검증합니다. 이 비공개 로컬 DB
사본에는 기존 계정 관련 바이트도 포함될 수 있지만, 계정 값을 전송 기록으로 조회하거나
내보내지는 않습니다. 백업 실패 시 SDK를 시작하지 않습니다. 사용 가능한 정확한 백업은
재사용하고, 관측한 DB 세대가 달라지면 별도로 보존합니다. 이후 사용자 수정을 전체 백업으로
자동 복원하지 않습니다.
백업 준비와 정확한 검증을 끝낸 뒤 SDK 시도를 기록합니다. 준비 실패만 발생했다면
SDK 시도가 없으므로 같은 요청으로 준비를 안전하게 다시 할 수 있습니다. SDK 시도가
기록된 뒤의 불확실성은 준비를 반복하거나 입력을 바꿔 없애지 않습니다.
등록 그룹에는 처음 선택한 메타데이터의 해시를 남깁니다. 완료된 멤버 결과는 실제 API
조회와 프로세스 정리 뒤의 선택 메타데이터 snapshot에 결합됩니다. 재개 시 이 원본들로
완료된 prefix를 재구성하며, SDK의 자동 발견만으로 미완료 멤버를 기존 사용자 선택으로
취급하지 않습니다. 중간 사용자 편집은 충돌로 보존하고, 완료 결과가 없는 snapshot은
불확실 상태로 유지합니다. 이 로컬 P5 기록은 Session 소유권·P2 복구 방향·실행 권한을
만들지 않습니다.

새 메타데이터에는 대상의
현재 설정과 runtime root를 사용합니다. 기존 대상의 선택은 덮어쓰는 resume 없이 검증합니다.
source의 prompt·모델·계정·권한을 대상 override로 전달하지 않습니다. 전송기는 모델 turn,
prompt 주입, 명령·도구 실행, 계정 API를 제공하지 않으며 서버의 action 요청도 거부합니다.
소유한 프로세스는 EOF, 짧은 대기, 정확한 프로세스 트리 정리 순서로 종료하고 기존 MCP는
그대로 둡니다.
EOF flush를 확인한 뒤 supervisor에 정상 종료 시간을 줍니다. EOF나 마지막 close에 응답이
없어도 정리 대기는 제한되며 불확실성을 명시합니다. 강제 종료·자발적 실패·미확인 정리를
등록 성공으로 승격하지 않습니다.

| 검증한 Codex 정책·조회 | 고정 Codex SDK에서 확인한 결과 |
| --- | --- |
| `read-only`, 독립된 paginated 합성 이력 | 메타데이터 등록과 원래 API 조회 내용의 동등성 검증 |
| `danger-full-access`, 동일한 격리 메타데이터 범위 | 명시적인 현재 설정과 원래 API 조회의 동등성 검증. 모델·명령 실행 없음 |
| `workspace-write`, 기본 및 추가 쓰기 경로·네트워크 옵션 | 실제 sandbox 조회가 선택한 정책을 재현하지 못함. 현재 명시적 resume 전에 미검증으로 중단 |
| 이름 있는 permission profile | 기존 sandbox 조회만으로 전체 동등성을 증명할 수 없음. 평면화·fallback 없음 |
| 실제 모델의 이어쓰기 | 미검증. `continuationReady: false`, 현재 instruction 결속도 미검증 |

등록을 통과시키려고 권한을 약하게 바꾸라고 안내하지 않습니다. 정책 검증이 실패하면
불완전·불확실 상태를 보존합니다. SDK 시작으로 메타데이터가 이미 바뀌었을 수 있으므로
“대상에 아무것도 쓰지 않았다”는 뜻은 아닙니다.

같은 성공 요청을 다시 확인할 때는 과거의 실제 SDK 검증과 현재의 raw prefix·타입 보존
원본을 함께 사용합니다. 새 SDK 조회와 다른 freshness 표시를 사용합니다. 검증된 결과가
영속화되지 않은 시도는 발견 과정에서 state 행이 생겼어도 불확실로 남습니다. SDK를
자동으로 다시 시작하거나 resume를 재전송하지 않습니다. 정책·root 인자를 바꿔도 그
불확실성을 피해 새 시도를 만들 수 없습니다. 저널 삭제나 ID 변경으로 재실행을 강제하지
말고, 남은 정확한 상태를 조사한 뒤 새로 필요한 중대한 행동은 사용자의 결정을 받습니다.

raw·이력 보존, SDK 메타데이터 등록, 현재 네이티브 연결, Lode P2 복구, 모델이 실제로
컨텍스트를 사용하는 것은 다른 결과입니다. 무엇을 검증했고 무엇이 미확인인지 분리해서
설명합니다. 성공한 조회를 권위나 의미적 연속성의 보장으로 바꾸지 않습니다.


## HANDOFF.md만 읽고 이어가기

새 export는 읽기 쉬운 `HANDOFF.md`를 기본 생성하고, 생성 당시 digest와 정확한
원본 basis를 최초 bundle manifest에 함께 고정합니다. 선택한 작업 목적, 원본의
조건·취소, 판단과 이유, 보고된 결과, 불확실한 효과와 남은 일을 담습니다.
저장된 관측만으로 완료를 추정하지 않습니다. 긴 작업 필드의 부분 범위와 bundle
안의 원문 object 링크도 표시합니다.

“이 HANDOFF.md를 읽고 현재 요청에 맞게 미완료 작업을 이어가자”라고 요청하면 됩니다.
파일을 읽는 데 Project·DB·provider·checkpoint·새 초기화가 필요하지 않습니다.

```sh
node scripts/lode.mjs project-bundle-inspect "<HANDOFF.md>"
```

기존 `lode_project_bundle_read`에도 `bundle_root` 대신 `handoff_file`을 전달할 수
있습니다. 인자는 에이전트가 준비합니다. byte 페이지는 부분 출력과 다음 offset을
표시하며, 필요한 나머지 근거를 추가로 읽을 수 있습니다.

Handoff는 인용된 P4 맥락이며 새로운 P2 방향이나 재승인이 아닙니다. 현재 대상의
조건·설정·취소가 우선합니다. 읽기는 링크 추적·명령 실행·선택 변경·완료 또는
불확실한 효과의 재시도를 하지 않습니다. 화면용 escaping을 원문 보존으로 주장하지
않으며, 연결된 object가 원래 byte를 보존합니다.

Handoff 누락·변경·안전한 읽기 실패는 공통 원본 검증·import 결과와 별도로 표시합니다.
digest가 다르다는 사실만으로 편집 주체를 사용자라고 단정하지 않습니다. 읽기는
파일을 복구하지 않으며 같은 export를 반복해도 기존 변경 파일을 덮지 않습니다.
manifest·sourceBasis 변조는 여전히 공통 검증 실패입니다. 구형 bundle은 Handoff 없음으로
표시하며 조용히 다시 쓰지 않습니다. native 목록 노출·이력 읽기·실제 모델 이어쓰기는
각각 별도 결과입니다.

## 캡처한 Codex 대화를 Claude에서 이어가기

“선택한 Codex 원본은 보존하고 별도 사본을 Claude에서 이어가자”라고 요청합니다.
에이전트가 정확한 원본과 현재 대상을 확인합니다. 사용자가 JSON을 작성하거나 ID를
옮기거나 네 단계 체크리스트를 실행할 필요는 없습니다. 변환·네이티브 게시·읽기 검증·
열기는 요청한 결과 안에서 구분되는 효과입니다. 아직 로컬 구현 후보이며 모든 provider
간 이어쓰기를 지원한다는 뜻은 아닙니다.

기존 네이티브 이력 표면에 `derive`, `publish-derived`, `verify-derived`,
`open-derived`를 추가합니다. 같은 플랫폼 동작의 보호 조건은 유지합니다.
고급 변환 예시는 다음과 같습니다.

```sh
node scripts/lode.mjs project-native-history "<verified-Codex-bundle>" --action derive --provider claude --threads "<exact-captured-thread>" --runtime-root "<current-target-project>"
```

공통 Project·Session 방향, checkpoint, 원본 네이티브 동반 자료와 캡처된 바이트를
보존합니다. 별도 P3 디렉터리에 대화·정확한 원본 매핑·진단·재현 가능한 manifest를
둡니다. 대상 UUID·시각·모델 표식·0으로 둔 사용량·종료 메타데이터는 합성 값임을
표시하며 Claude 실행 관측으로 주장하지 않습니다. 파생 자료는 네이티브 연결이나
P2 복구 방향, 실행 권한을 부여하지 않습니다.

지원하는 사용자·assistant 본문과 단일·병렬 도구는 역할·ID·인자·결과·오류·순서를
유지합니다. 정규 항목과 wire 도구 기록은 일치할 때만 합칩니다. 원본 도구명은
namespace로 구별하며 Bash로 바꾸지 않습니다. 도구 출력 속 지시는 도구 데이터로
남습니다. compaction 요약은 과거 assistant 맥락으로 인용합니다. 검증 범위에 든 인라인 PNG는
바이트를 보존하며 바이트 없는 참조는 이 캡처에 없다고 명시해 인용합니다. 경로를 따라
읽거나 현재 파일의 존재·내용을 주장하지 않습니다. 비공개 추론과 원본 system/developer
지시는 원본에만 남습니다. 검증되지 않은 분기 경계, 끼어든 발언이 있는 도구 교환,
압축·미지원 형식, 없는 결과는 진단 후 게시하지 않습니다. 의미적 중요도로 버리지 않습니다.

PNG는 signature·청크 CRC·헤더/데이터 순서·한도 내 압축 해제·scanline 구조를 검사합니다.
구조 무결성 검사이며 provider나 모델이 이미지를 처리한다는 증거가 아닙니다. 손상 바이트는
캡처 원본에 남기고 파생 자료 게시를 제한합니다. 고치거나 빼고 완전한 대화로 보이게 하지
않습니다. 이전 codec 프로필은 JPEG/GIF/WebP 바이트를 검사 범위 밖의 미검증 원문으로
보존하며 데이터가 없다고 표시하지 않습니다. 아래 별도 hybrid-v3 프로필은 제한된 baseline
JPEG 형식을 검증합니다. 기존 검증 입력은 profile v2를 유지하고,
완료 관측·원본 행 바이트 해시·미상 wire 결과를 보존하는 입력은 profile v3를 사용합니다.
이전 로컬 후보는 변경하지 않고 `DERIVED_CONVERTER_PROFILE_UNQUALIFIED`를 표시합니다.
별도 요청한 새 파생 자료는 새 신원을 가지며 기존 대화를 덮어쓰지 않습니다.

네이티브 동작은 `derivation_id`, `expected_derivation_digest`를 정확한 대상 루트·
프로필·실행 파일에 결합합니다. CLI에서는 `--derivation`, `--expected-derivation`을
쓰며 에이전트가 검증된 결과에서 값을 이어받습니다. 기존 2.1.223 복원 계약과 별도로
Claude Code 2.1.317을 확인합니다. 선택적 공식 SDK0.3.234 읽기는 후속 네이티브 메시지까지
모든 UUID·역할·본문·도구 블록·순서를 대조합니다. 페이지 크기는 전체 이력 상한이
아닙니다. 풍부한 합성 메시지 174개의 격리 읽기는 통과했으며 실제 Desktop·모델 검증은
남았습니다. SDK가 없어도 변환·게시는 가능합니다.

네이티브 이어쓰기 후에도 `rawCoverageComplete`는 모든 raw 사용자·assistant 기록을
뜻합니다. `readerProjectionCoverageComplete`는 관측된 Desktop2.1.317/SDK0.3.234의 후속
local-command-caveat envelope만 명시된 reader 생략으로 분리합니다.
`derivedPrefixCoverageComplete`는 최초 파생 부분을 확인합니다. 모든 누락 UUID를 표시하며
raw coverage는 계속 false입니다. 임의의 metadata flag나 비슷한 문구로 사용자·도구 메시지
누락을 허용하지 않습니다. UUID로 정렬·본문을 대조하므로 한 건의 생략 때문에 이후 전부를
변경됐다고 표시하지 않습니다. reader 투영은 증거이며 권위가 아닙니다.

게시는 완전한 새 ID JSONL 하나만 없는 위치에 원자적으로 만듭니다. 공용 인덱스·설정·
DB를 쓰거나 기존 Desktop 쓰기 프로세스를 종료하지 않습니다. 동일한 바이트는 다시 쓰지
않고 관측하며 충돌·부분 append·불명확한 시도는 보존합니다. 불확실한 시도 후 대상이
삭제되어도 자동 재생성하지 않습니다. 모델 호출·과거 도구 실행·인증정보 이동·프로필
전환·설치·재시작은 발생하지 않습니다.

열기는 게시나 질문 전송을 숨겨 수행하지 않습니다. 기본 실행기는 자식 트리 전체를
정리하므로 외부 GUI 인계로 검증되지 않았습니다.
`DERIVED_DESKTOP_HANDOFF_LIFETIME_UNQUALIFIED`와 정확한 샘플의 공식 Desktop 로컬
`/resume` 대안을 반환합니다. 별도 검증된 신뢰 Host 기능은 고정된 공식 resume 인자만
사용할 수 있으며 shell 문자열이나 prompt는 받지 않습니다. callback·CLI 반환은 화면
표시 증거가 아니며 지정한 프로필을 이미 실행 중인 Desktop이 읽는다는 증거도 아닙니다.
미완료 원본·네이티브 작업은 열기만 제한합니다. 불명확한 열기는 자동 반복하지 않습니다.
독립적인 변환·검토는 계속 가능하며 정리를 약화하거나 비공개 Desktop 메타데이터를 써서
열기를 강제하지 않습니다. 화면 표시·모델의 맥락 활용·답변 저장은 각각 관측해야 합니다.

관측된 Desktop 로컬 선택기에서는 UUID 검색에 결과가 없었지만 화면 제목으로 정확한
샘플을 열었습니다. 검증된 원본이나 공식 reader 메타데이터에서 제목·첫 질문 힌트를
확인하고 Project와 최신 조건을 대조합니다. 정확한 UUID는 신원의 근거이며 선택기에서
검색된다는 보장은 아닙니다.

## Codex 캡처의 정확한 프로젝트 소속 확인

Codex `capture`에는 Host가 확인한 정확한 `source_project_id`
(CLI `--source-project`)를 전달할 수 있습니다. `thread_ids`/`--threads`를
생략하면 네이티브 `threads.project_id`가 해당 ID와 일치하는 모든 행을
선택하며, 보관 대화·자식 worker·서로 다른 작업 폴더도 포함합니다.
대화를 직접 선택했다면 모두 해당 프로젝트 소속인지 확인하고, 일부만
선택한 결과에는 부분 선택임을 표시합니다. 제목·작업 경로·Git 원격 주소는
소속 근거가 아닙니다. 검증된 선택은 HEAD가 제공하며 사용자가 ID나 JSON을
직접 작성할 필요는 없습니다. 다른 provider나 작업에 이 인자를 사용하면
네이티브 프로필에 접근하기 전에 거부합니다.

`CodexProjectCatalog`는 고정된 `projects`·`threads` 스키마에서 얻는 P3
증거입니다. 선택된 프로젝트의 헤더에는 이관 색인에 표시할 ID·이름만
보존합니다. 전체 대화 목록에는 ID·소속·cwd·보관/source 상태·attached
parent ID만 포함합니다. 미선택 대화의 제목·첫 발화·preview·정책·원격 URL·
계정과 임의의 프로젝트 metadata는 제외합니다. 두 조회는 같은 SQLite
읽기 스냅샷을 사용합니다. 전체 state 행은 실제 선택된 대화만 수집하고,
payload는 해당 행의 최소 목록 투영이 정확하게 일치하는지 검증합니다. 빈 프로젝트의 목록도 유효하지만, 대화가
없는 이력 캡처는 payload를 생성하지 않고
`NATIVE_CODEX_PROJECT_HAS_NO_THREADS`를 알립니다. 목록은 네이티브 DB의
해당 스냅샷 범위만 증명합니다. Host 화면 목록·로그에만 남은 대화·임시
대화는 미관측입니다. 기존 쓰기 프로세스 검사도 유지하며 앱을 종료하지
않습니다.

이는 기존의 선택된 Lode 논리 Session 번들에 프로젝트 소속 증거를 더한
단계입니다. 코드·worktree 파일이나 첨부를 복사하거나, 모든 Lode 논리
Session을 열거하거나, 네이티브 대화의 논리 Session 소유권을 만들거나,
프로젝트 전체 이관을 완료하는 기능은 아닙니다. 변환된 대화는 P2 방향을
작성하지 않습니다.

같은 native-history 표면의 `capture-project`는 정확한 `source_project_id`·
`native_home`·`executable`로 `bundle_root` 위치에 독립적인 Codex 프로젝트
이력 캡처를 만듭니다. Lode 초기화나 공통 번들이 필요하지 않습니다. 기존
쓰기 프로세스·버전 검사는 유지하며 앱 종료나 provider 자동 시작은 없습니다.
`derive`는 기존 공통 번들뿐 아니라 검증된 독립 Codex 네이티브 payload도
읽습니다. 이 경우 원본 연결에는 네이티브 신원만 기록하며, Lode 정본
Project나 논리 Session을 만들어내지 않습니다. 이는 후속 연결의 기반이며
다중 대화·파일 복사 이관 UX 전체의 완료를 뜻하지 않습니다.

목록의 전수 조회는 캡처 당시의 관측입니다. 나중의 payload 검사는 저장된
목록의 구조와 선택 행의 연결을 검증하며 원본 DB 질의를 다시 수행하지
않습니다. 수정된 외부 목록의 누락 여부까지 독립 증명하거나 Host 전체
조회 완료를 인증하지 않습니다. 원본 payload ID·digest를 유지하고 이
검증 범위도 결과에 표시합니다.

## 프로젝트를 여러 개의 독립 대화로 옮기기

선택한 Codex 프로젝트를 Claude로 옮기되 대화를 각각 유지하고, 코드 폴더는
재사용할지 새 폴더로 코드·문서를 복사할지 말하면 됩니다. 정확한 네이티브
Project·대화 목록·현재 작업 폴더 선택은 HEAD가 전달합니다. 사용자가 ID·
매핑·plan JSON을 작성하지 않습니다. 코드, 네이티브 대화, 선택적인 Lode
기록은 서로 다른 범위입니다.

기존 `project-native-history` CLI / `lode_project_native_history` typed 표면에
다음 흐름을 연결했습니다.

1. `capture-project`로 검증된 네이티브 프로젝트 원본을 보관합니다. 기존
   버전·쓰기 프로세스 검사를 유지합니다. 원본 앱이 실행 중이면 사용 불가를
   알리며 캡처를 위해 앱이나 MCP를 종료하지 않습니다.
2. 선택적인 `prepare-workspaces` / `copy-workspaces`는 현재 Host가 선택한
   저장소 소유 코드·문서 경로를 사용합니다. HEAD가 반환된 plan·digest를
   복사 호출에 전달하므로 별도의 사용자 승인 의식은 없습니다. digest는
   무결성 근거이며 권한이 아닙니다. 재사용은 복사하지 않고, 복사는 대상의
   수정본을 보존하며 충돌을 알립니다. 모든 깊이의 클라이언트 전용 폴더,
   `.git`, `.lode`/`.head`, 자격증명과 `.env`는 내용을 읽지 않고 제외합니다.
   `.env.example`, `.env.sample`, `.env.template`은 선택할 수 있습니다.
   같은 원래 plan으로 이미 복사된 파일을 안전하게 관찰할 수 있습니다.
   의존성 설치·프로그램 실행 가능성 검증·외부 첨부 탐색·전체 worktree를
   빠짐없이 선택했다는 주장은 하지 않습니다.
3. `derive-project`는 현재 호출자가 지정한 `collection_root`에 불변 P3
   대화 모음을 만듭니다. 각 대화에는 독립된 단일 대화 원본 capsule과
   Claude 변환본이 있습니다. 전체 목록이 바뀌어도 대화별 입력과 대상
   폴더 신원이 같으면 이전 변환본·네이티브 ID를 재사용합니다. 대화를
   이어 붙이지 않습니다. 사용자가 선택한 같은 작업 폴더에 독립 대화를
   모을 수 있지만 코드 트리나 P2 소유자를 병합하지는 않습니다. 실제 코드·
   문서 복사에서는 서로 다른 원본 worktree를 한 대상에 합치지 않습니다.
   폴더 매핑이 없으면 해당 대화만 대기하고, 미지원 표현은 원본을 보존한
   채 대화별로 표시합니다. 권한·신원·무결성 실패는 원래 실패를 유지하며
   성공한 미지원 형식 처리로 바꾸지 않습니다.
4. `read-project`는 읽기 전용입니다. `publish-project`·`verify-project`에는
   정확한 모음 digest와 현재 호출자가 별도로 지정한 작업 폴더 매핑·
   프로필이 필요합니다. 각 대화의 기존 게시 journal을 사용하므로 대상에서
   이어 쓴 내용은 보존하고, 불확실한 효과를 재시도하거나 되돌리지 않습니다.
   게시, 공식 reader coverage, Desktop 표시와 모델 사용은 별개 결과입니다.
   대화 모음은 공유 실행 권한이 아닙니다.
   batch의 `nativePublication`·`officialReader`는 실제 관측한 대화를 집계하며
   archive reader의 쓰기 없음 표시를 재사용하지 않습니다. 실패하면 원래
   오류와 이미 관측했거나 불확실한 대화·미방문 ID를 CLI JSON 또는 MCP
   오류 data의 `partialNativeOperation`에 함께 전달합니다. 권한 거절 뒤에는
   원본·프로필 추가 관찰, 재시도나 rollback을 하지 않습니다.
5. 선택적인 `attach-project-lode`는 이미 내보내 검증한 Lode Session 번들과
   명시적인 연결 증거를 보관합니다. 정본 Project·Session 신원은 네이티브
   ID와 구분합니다. 초기화·import·소유자 병합·checkpoint 통합을 하지 않고,
   모든 논리 Session을 포함했다고 주장하지 않습니다. 네이티브 대화만
   옮겨도 됩니다. 연결 증거는 기본 모음을 덮어쓰지 않는 별도 기록입니다.
   기존 `lode_project_bundle_import`와 정확한 Session의
   `lode_conversation_enter` 후속 경로도 반환합니다. 실제 현재 이관 범위에서만
   import하고 복구된 P2·현재 대상의 공통 제약을 확인합니다. 기존 import는
   대상의 더 최근 취소와 독립 소유자를 보존합니다. 연결 기록·대상 추천만으로
   효과 권한이나 Session 선택이 생기지 않습니다.

CLI에는 `--collection-root`, `--collection`, `--expected-collection`,
`--workspace-map`, `--workspace-transfers`, `--lode-bundles`를 추가했습니다.
마지막 세 인자는 Host가 구조화해 전달하며 일반 사용자는 대화·typed MCP를
사용합니다. P3 모음·번들은 보관 증거, P4 조회는 뷰, 게시·파일 작업은 P5이며
어느 것도 P2 방향을 만들지 않습니다.

완료 기록의 ordinal과 실제 도구 호출 순서가 다를 수 있어, 해당 입력은
별도 변환 profile v3에서 같은 turn의 고유한 호출·인자·결과를 대조합니다.
기존 검증 입력의 v2 신원은 유지합니다. wire 결과의 오류 여부가 없으면
네이티브 오류 필드도 생략하고 미상 근거를 남깁니다. `ok` 같은 텍스트를
성공으로 추론하지 않으며, 수치 정밀도가 소실되는 입력은 원본을 보존하고
미지원으로 표시합니다.

### 별도로 캡처된 물리적 대화 이력 연결

`capture-physical`은 명시적으로 선택한 기존 JSONL 캡처의 prefix를 읽습니다.
물리 rollout ID, 안정적인 native thread ID, 배타적 byte 경계와 원본 digest는
검증된 캡처 근거에서 HEAD가 전달합니다. 사용자가 작성하는 입력이 아닙니다.
선택한 leaf와 명시된 `history_base` 조상만 읽고, 부모의 이후 내용·형제 대화는
읽지 않습니다. 복사된 상속 prefix는 한 번만 포함합니다. 안정적인 thread,
물리 rollout, 루트 Session의 신원은 구분합니다. raw `ItemCompleted`와 같은
turn의 정확한 도구 호출·결과를 의미 변환하며 가상의 canonical DB 행은
만들지 않습니다. 미지원 수정·rollback 표현은 원본을 보존하고 해당 변환본의
게시만 보류합니다.

선택적으로 정확한 selected-state 캡처 파일·digest를 전달하면 그 안의
`rollout_path`와 실제 캡처 파일 신원을 대조합니다. ID만 같으면 연결 제안입니다.
오래됐거나 사라진 경로는 제안으로 남기되 권한·digest 실패는 원래 오류를
유지합니다. 이는 기록된 캡처의 정합성이며 생산자 진위·현재 목록·여러 원본이
동일 시점의 snapshot이라는 증명은 아닙니다.

물리 변환 profile v2는 새 완성 JSONL에 공식 `custom-title` 기록을 포함합니다.
captured selected-state의 대화명이 있으면 표시용으로 길이를 줄여 유지하고,
안정적인 native ID·기록된 분기 부모를 함께 넣어 첫 문장이 같은 대화를
구분합니다. 대화명이 없으면 의미를 추측하지 않고 기록된 신원으로 표시합니다.
인용·합성한 부분의 출처는 manifest에 남습니다. 이는 목록 메타데이터이지
새 사용자 발화·모델 지시·P2가 아닙니다. 이미 게시했거나 이어 쓴 대화의
이름은 바꾸지 않습니다. 공식 SDK 제목·목록 확인과 실제 Desktop 표시·검색·
모델 사용의 검증은 구분합니다.
이미 있는 physical-v1 변환본은 기록된 형식으로 정확히 재현하고 원래 native
ID·게시 시도 journal을 재사용합니다. 제목을 추가하려고 두 번째 대화를 자동
생성하지 않습니다. 현재의 turn 검사는 계속 적용합니다. 기존 profile intent가
충돌하면 효과를 임의로 선택하거나 다른 ID를 만들지 않고 충돌을 보존합니다.

`assemble-project`는 캡처한 프로젝트 목록과 선택한 물리 대화 원본·현재 폴더
매핑을 연결합니다. 원본 또는 연결 근거가 없으면 해당 대화만 대기합니다.
변환본은 **원래 캡처 저장소**에 생성하거나 재사용하며 별도 게시 journal을 가진
복제본은 만들지 않습니다. 모음에는 목록·정확한 원본 manifest 메타데이터와
변환본·저장소 참조만 들어가고 **물리 원문 본문은 포함되지 않습니다**.
`read-project`는 저장된 경로를 따라가지 않고 기록된 메타데이터만 대조합니다.
원래 저장소 없이 이 모음만 다른 PC로 옮겨 복구할 수 있다고 주장하지 않습니다.

`publish-project`·`verify-project`에서 HEAD는 현재 허용된 정확한 원래 저장소를
`retained_derivation_sources`로 전달합니다. 기록된 경로는 접근 권한이 아닙니다.
범위나 저장소가 없으면 해당 대화만 대기합니다. 교체·복제된 저장소와 변경된
아티팩트는 검증에 실패하며 작업 내내 원래 저장소 신원을 재확인합니다.
모음 생성 후 단독 게시가 시작되거나 모음 요청과 경합해도 원래 시도 journal을
공유합니다. 불확실한 효과는 재실행하지 않고 대상에서 이어 쓴 내용을 보존합니다.
이는 알려진 로컬 저장소 조정이지 독립 재캡처·유실 journal·다른 PC 전체의
전역적인 단 한 번 실행 보장은 아닙니다.

CLI 인자는 `--physical-source-root`, `--physical-rollout`, `--physical-files`,
`--selected-state-evidence`, `--expected-selected-state`, `--catalog-file`,
`--expected-catalog`, `--physical-sources`, `--retained-derivation-sources`입니다.
HEAD·Host가 현재 범위를 구성하며 사용자는 여전히 대화로 이관을 요청합니다.
코드·문서 준비에는 전체 구형 payload 대신 정확한 catalog 파일·digest도
사용할 수 있습니다.

남은 범위도 명시합니다. 프로젝트 캡처는 기존 payload·offline 어댑터이며
실행 중인 원본의 snapshot backend가 아닙니다. WAL DB의 `readOnly` 열기만으로
공유 메모리 sidecar 생성이 방지되지는 않아 원본 무쓰기 live backend의 증거로
쓰지 않습니다. 다른 시작·migration·scan/repair·launcher로 이를 우회하지 않습니다.
물리 대화 의미 변환은 소스 형식을 따른 합성 시험이며 실제 모든 Codex fork·
rollback·compaction 형식의 인증이 아닙니다. 기존 Lode 번들은
선택한 Session만 포함하며 전체 Session 자동 수집이 아닙니다. 합성 시험과
공식 SDK 읽기는 새 Desktop 화면·모델 동작의 검증이 아닙니다. 자동 GUI
전달은 여전히 미검증이며 보안 정책의 거부를 우회하지 않습니다.

### 이동용 증거 묶음

`portable-project-evidence.mjs` 모듈은 선택한 물리 대화 원문, 추출한
프로젝트 목록 값, 명시적으로 선택한 기존 Lode Session 번들 원본을 P3로
내보내고 검증합니다. 객체는 내용 digest로 보관하며 각 Session·Project의
신원을 유지합니다. 조회는 묶음 안의 객체와 물리 prefix 계보만 검증하고
기록된 원본 경로 접근·Project 초기화·복구 방향 import를 하지 않습니다.
묶음 루트에는 실행 가능한 네이티브 원본 manifest를 만들지 않습니다.
`materializePortableProjectSessionBundle`은 명시적으로 선택한 common Session
번들 하나만 별도의 P3 임시 폴더로 재구성하고 기존 typed bundle 검사기로
재검증합니다. 기존 import 경로를 반환하되 실행·Session 선택·네이티브 원본
저장소나 효과 journal 생성은 하지 않습니다. 현재 범위에서 별도로 import하고
정확한 Session으로 진입한 뒤에야 원래 P2를 복구하며, 더 최근 대상 제약을
보호하는 기존 import 검사를 유지합니다.

알려진 변환본 본문과 원본 저장소의 P5 시도·결과 기록도 관측 범위·digest와
함께 원문으로 보관합니다. 관측은 제한된 비원자적 범위이며 기록이 없거나
건너뛰었거나 수집하지 못했다고 해서 이전 시도가 없었다고 증명하지 않습니다.
기록된 대상 경로는 기기 신원이나 권한이 아닙니다. 대상 어댑터는 새로운
기기로의 의도된 이관과 이미 알려진 불확실한 재실행을 구분해야 하며,
묶음 복사본을 빈 게시 journal로 취급해서는 안 됩니다.
0바이트나 형식이 깨진 과거 작업 기록도 정확한 해시와 함께 해석되지 않은
원본으로 보존합니다. 바이트 보존이 유효한 JSON이나 확정된 결과를 뜻하지는
않습니다. 객체·묶음 구조를 검증한 뒤 create-only manifest를 게시합니다.
게시 중·게시 후 실패하면 복사된 객체 관측을 유지하고, 게시 결과가 미확정인
경우와 manifest가 확인된 뒤 최종 조회만 실패한 경우를 구분합니다. 권한 실패
후에는 rollback이나 추가 파일 관찰을 하지 않으며 후속 조회에는 현재 범위가
필요합니다.

기존 native-history CLI·typed MCP의 `export-project-evidence`,
`read-project-evidence`, `stage-project-session`으로 사용합니다. 사용자가
보관할 Project·대화와 선택적인 Session 기록을 말하면 HEAD가 현재 원본 범위·
archive digest·선택 번들을 전달하며 사용자가 descriptor JSON을 쓰지 않습니다.
이 P3 작업에는 provider·네이티브 home·실행 파일 인자를 넣지 않고, Host에
실행 기능이 있어도 호출하지 않습니다. CLI의 조회·임시 복원 범위는
`--archive`, `--expected-archive`, `--session-bundle`, `--output-directory`입니다.
실패하면 원래 오류와 관측된 부분 결과를 CLI JSON·MCP error data의
`partialPortableEvidence`에 유지합니다. 증거 작업에 Project·Canon·Run 초기화나
새로운 승인 의식을 추가하지 않습니다.

위 세 작업은 계속 증거만 다룹니다. 아래의 실행 중 원본 수집·대상 PC 게시 흐름은
이 증거를 실제 전달과 연결하되, 묶음 자체를 실행 권한으로 취급하지 않습니다.

### Codex 프로젝트를 독립된 Claude 대화로 옮기기

“이 Codex 프로젝트와 대화들을 Claude로 옮기고, 각 대화와 이력을 따로 보존해줘”라고
요청합니다. HEAD가 확인한 프로젝트·물리적 원본 ID, archive digest와 현재 대상 매핑을
이어받습니다. 사용자가 descriptor JSON을 쓰거나 Product·Run·Canon을 초기화할 필요는
없습니다. 선택적인 코드·문서 복사와 기존 공통 Session import는 별도 범위입니다.
대화들을 같은 폴더에 표시해도 코드 트리·소유자·P2 방향성을 합치지는 않습니다.

1. `capture-live-project`가 선택한 Codex 프로젝트를 이동용 P3 묶음으로 수집합니다.
   `provider: codex`, 현재 명시적으로 선택한 `native_home`, `source_project_id`와
   사용자가 동의한 `source_sync_files` 설정을 전달합니다. `thread_ids`는 선택적인
   부분 집합입니다. 선택한 부모의 현재 경로는 자동으로 연결합니다. 물리 의존 파일의
   위치가 없으면 같은 프로젝트의 현재 위치 메타데이터와 그 행이 직접 참조한 폴더의
   파일명만 비재귀로 확인합니다. 유일한 후보의 헤더가 현재 프로젝트 소속임을 확인한
   뒤에만 정확한 상속 cutoff까지 본문을 읽고 보존합니다. 후보 중복이나 탐색 범위 밖의
   위치는 `unresolvedLineageConversations`를 포함한 대화별 부분 결과로 남깁니다.
   `ancestor_files`는 현재 접근 권한을 확인한 Host가 전달하는 선택적 의존 원본 목록이며,
   사용자에게 JSON 작성을 요구하거나 대화 본문의 경로를 따라가지 않습니다. 전체 이력을
   스캔하거나 원본 접근 범위를 조용히 넓히지 않습니다. 지원하는 Windows 형식에서
   독립적인 SQLite 읽기 전용 스냅샷과 기존 DB·WAL의 삭제·이름 변경 방지를 사용합니다.
   동기화 보조 파일은 합의한 범위에서만 허용합니다. WAL이 없으면 이 수집 경로만
   미지원으로 표시하며, WAL 생성·무시·수리·복사는 하지 않습니다. 기존 writer의
   append·checkpoint·truncate는 허용하며 전체의 단일 시점이나 writer 중지를
   주장하지 않습니다. 읽기 연결과 소유한 숨김 보호 프로세스가 종료된 뒤에만 저장
   성공을 반환합니다.

   실시간 선택 읽기는 정확한 스키마·마이그레이션, 선택한 typed 행과 원본 주소를
   검증하며 `wholeDatabaseIntegrity`는 `not-observed`로 남깁니다. DB 전체의
   `quick_check`·`foreign_key_check`를 선행 조건으로 실행하지 않습니다.
   오프라인 DB 무결성 검사는 두 검사를 유지합니다. 스키마·선택 읽기·파일 식별자·
   권한·원본 prefix 오류는 그대로 주된 실패로 보존합니다.

   기록된 사용자 fork는 부모 prefix를 상속하면서 새 논리 root를 시작할 수 있습니다.
   root 변경은 자식 Session ID가 자기 thread ID와 같고, 명시된 fork 부모가 보관한
   부모 헤더와 일치하며, fork ordinal이 정확한 물리 base cutoff와 같을 때만 허용합니다.
   같은 thread의 물리 continuation에서 root를 바꾸는 것은 계속 거부합니다.
   각 구간의 root를 별도로 보존하며, 선택한 root가 논리 Session 소유권을 합치거나
   실행 권한을 부여하지 않습니다.

   앱 사이드바의 Project ID와 네이티브 DB Project ID는 다를 수 있습니다. 현재 요청의
   정확한 선택에는 HEAD가 `source_selection_file`, `expected_source_selection_digest`와
   별도로 허용된 `source_project_root`, 명시적인 native home를 전달할 수 있습니다.
   `CodexExplicitProjectSelection`은 P3 선택자이며 Host 인증·권한·검증된 앱 소속·P2
   방향성이 아닙니다. 별도 종류인 `CodexExplicitConversationCatalog`는 앱 참조와 실제
   네이티브 `project_id`의 `null`을 포함한 값을 그대로 보존하며 같은 cwd 대화를 추가하지
   않습니다. 이 경로는 호출자가 허용한 한 소스 작업 폴더로 한정하며 선택한 모든 cwd가
   같은 물리적 root로 연결돼야 합니다. Windows 일반·확장 표기는 원시 문자열을 보존하고
   실제 containment와 열린 파일 identity를 검사합니다. 파일 identity의 null은 관측 시
   부재를 뜻하며 미검증 identity가 아닙니다. 이후 파일이 생겨도 새 명시 관측 전까지 부분
   결과로 남기며 다른 선택 대화의 조상으로 참조돼도 동일합니다. 현재 호출자의 권한은
   선택자 바이트와 별개입니다. 파일과 digest는
   HEAD가 처리하므로 사용자가 JSON을 작성하거나 ID를 수동 연결하지 않습니다.

   과거 생성 버전 `0.158.0-alpha.2.1`, `0.159.2`, `0.160.0`, `0.163.0-alpha.10.2`,
   `0.165.0-alpha.1.2`, `0.166.0-alpha.5.1`은 제한된 paginated 물리 parser로 검증했습니다.
   현재 DB와 대상 runtime의 고정 버전은 유지합니다. ordinal·base·root·cutoff·hash와
   엄격한 event 변환 검사는 계속 적용하며, 미지원 생성 형식은 원문을 보존한 부분 증거로
   남고 게시 가능으로 승격하지 않습니다. `stateHeaderAgreement`는 원문을 바꾸지 않고
   metadata 불일치를 기록합니다. 물리 범위 검증은 의미 변환이나 모델 맥락 동일성 판정이
   아닙니다.
2. 묶음을 옮긴 뒤 `read-project-evidence`로 원래 PC·DB·원본 경로·네이티브 실행 파일
   없이 검증합니다. typed state/history, 조상 원문의 정확한 범위, raw-only 완료 기록,
   미완성 끝부분과 대화별 원본 누락·미지원 상태를 구분해 보존합니다. 대화 하나가
   없다고 나머지를 버리지 않습니다. 권한 거부·취소·신원·해시 실패는 원래 오류를
   유지하며 종속 효과를 중단합니다.
3. `read-portable-project`는 읽기 전용 조회입니다. `derive-portable-project`는 공통
   재현 코덱으로 독립된 Claude 변환본을 준비하고 기존 P3 intent와 ID를 재사용합니다.
   정확한 archive/digest와 현재 대상 폴더 매핑 또는 명시적으로 공유할 `runtime_root`를
   전달합니다. 이 두 작업은 네이티브 클라이언트를 시작하거나 프로필에 쓰지 않습니다.
   실행 가능한 원본 복제본이나 새 공통 Session도 만들지 않습니다.
4. `admit-portable-targets`가 현재 지정한 대상을 대상 PC Host 소유 P5 저장소에 한 번
   기록합니다. 이미 승인된 정확한 대상 요청 안에서 HEAD가 수행하는 준비이며,
   추가 Product 검토나 대화마다 반복하는 승인 절차가 아닙니다. 기본 Host가 저장 위치와
   host identity를 소유하며 묶음·일반 호출자의 JSON이 이를 정하지 않습니다. Windows는
   `%LOCALAPPDATA%/Lode/native-imports`, 다른 Host는 로컬 상태 폴더를 사용합니다.
   조회나 게시가 없는 Host·대상 기록을 초기화하지 않습니다. 유실·교체·복제·부분 기록을
   자동으로 새 대상이라고 취급하지 않습니다.
5. `publish-portable-project`는 검증한 현재 Claude Host와 대화별로 독립적인 로컬
   claim·lease를 사용합니다. 활성 상태의 정확한 lease 안에서만 일회성 파일쓰기 권한을
   발급합니다. 없던 완전한 JSONL만 생성하며 이어쓴 파일·충돌 파일 덮어쓰기, 공용
   네이티브 메타데이터 변경, 앱 종료, GUI 열기나 모델 프롬프트 전송은 하지 않습니다.
   반복·복제 요청은 현재 대상과 보존된 결과를 관측하며 불확실하거나 완료된 게시를
   재실행하지 않습니다.
6. `verify-portable-project`는 검증된 설치 SDK로 현재 출력한 prefix의 역할·본문·UUID·
   순서·도구를 대조합니다. 기계적 일치는 의미적 충분성·Desktop 표시·모델 이어쓰기와
   별개입니다. transcript나 CLI exit0만으로 뒤의 결과까지 입증하지 않습니다.

미완성 원문 끝부분은 P3에 그대로 남기고 `remainingSourceUncertainties`로 설명합니다.
이를 prefix 게시의 자동 게이트로 삼지 않습니다. `pendingThreadIds`는 요청한 작업에서
남은 일을 뜻합니다. 같은 native ID 또는 범위를 확인할 수 없는 이전 작업은 해당 대화의
네이티브 효과만 제한합니다. 처음 확인한 불확실성은 로컬 P5 저장소에 한 번 보존하므로
뒤의 묶음에서 그 이력을 빼도 지워지지 않습니다. 예전 경로·inode로 다른 PC라고
단정하거나 시도를 초기화하지 않습니다. 모든 증거가 지워진 뒤의 전역 exactly-once
재구성은 불가능하며 보장하지 않습니다.

과거 대상 ID는 게시 기록의 정확한 원문, 그 당시의 manifest·intent, input digest,
캡처 원본과 선택 대화, 지원 converter, 결정적으로 계산한 native ID, 저장된 운영
namespace를 연결해 검증합니다. UUID가 다르다는 이유만으로 무관한 시도라고
판정하지 않습니다. 근거 누락·미지원 schema/profile·손상된 본문·연결 불일치는
opaque로 남기고, 실제 원문 바이트·권한·신원 검증 실패는 최초 오류로 유지합니다.
이 순수 분류는 실행 증표나 재실행 권한을 부여하지 않으며 현재 대화의 원문 표현도
바꾸지 않습니다. 관리되는 P5 namespace의 unknown·partial 항목은 지원되는 파일
원문과 명시적 범위 메타데이터로 보존합니다. 구 아카이브의 미분류 항목은 관측 범위의
불확실성으로 남기며, 실행된 과거 시도를 새로 만들어내거나 안전한 빈 이력으로 지우지
않습니다. 정상 이관에 사용자 양식이나 추가 승인을 요구하지 않고, 불확실한 해당
효과만 미완료로 유지합니다.

묶음과 변환 증거는 실행 권한이나 P2 복구 권위가 아닙니다. Host 저장소·저널 결과·
원본 대화는 ReviewDecision·Product Canon·현재 Session 선택·작업 완료가 되지 않습니다.
현재 후보는 검증된 Claude CLI 2.1.317 / Agent SDK 0.3.234 프로필에서 유한하게
캡처한 대화 세 개로 실사용 검증했습니다. 출력 메시지 250,631개가 공식 reader와
일치했습니다. 세 대화 모두 공식 Desktop 로컬 `/resume` 선택기와 실제 대화 화면에서
확인했고, 정확한 native ID 연결과 열람 후 원래 prefix의 바이트 보존을 검증했습니다.
이 확인 과정에서 새 모델 프롬프트를 전송하지 않았습니다.

이는 선택한 사본과 관측한 화면의 검증입니다. 향후 모델이 이관한 전체 맥락을 활용하는지,
원본의 이후 발화가 자동으로 동기화되는지, 다른 클라이언트 버전에서도 동작하는지는
미검증입니다. 새 대상은 저장·reader·화면을 각각 확인해야 하며, 저장된 성공 결과가
게시 재실행이나 과거 작업의 자동 이어쓰기를 허용하지 않습니다.

코드·문서도 요청했다면 HEAD가 live 수집이나 증거 내보내기에 `workspace_sources`로
현재 프로젝트 작업 폴더와 승인된 저장소 소유 파일 목록을 전달합니다. 각 작업 폴더의
범위는 따로 유지합니다. 바이너리·빈 파일도 스트리밍한 content-addressed 객체로
저장하며, 검증하려고 전체 코드 파일을 Context에 넣거나 네이티브 transcript decoder의
바이트 상한을 적용하지 않습니다. 명시적으로 선택한 범위이며 모든 저장소 파일·빌드
의존성이 포함됐다는 뜻은 아닙니다. 선택 파일의 누락과 제외 항목도 표시합니다.

같은 묶음을 옮긴 뒤 `restore-portable-workspaces`가 현재 `workspace_targets`의
`copy` 또는 `reuse` 선택을 사용합니다. 원래 PC 경로를 열지 않습니다. 현재 범위에
따라 새 폴더를 만들 수 있으며 이미 동일한 파일은 다시 쓰지 않습니다. 충돌한 작업
폴더는 그대로 두고 독립적인 다른 폴더는 진행할 수 있습니다. 서로 다른 원본 폴더를
대상 하나로 몰래 합치지 않습니다. `nextConversationMappings`가 이미 합의한 복원·재사용
폴더를 대화 이관으로 이어주므로 다시 승인하거나 ID·JSON을 직접 작성할 필요가 없습니다.

규칙으로 식별한 Git·자격증명·환경 파일·개인 클라이언트/사용자 경로·Host 연결 설정은 중첩
경로에서도 제외합니다. 에이전트 지시 파일은 수동적인 증거로 보존하며 대상 작업
폴더에서 자동 활성화하지 않습니다. 원본 ACL·소유권·실행 비트는 가져오지 않습니다.
관측할 수 있는 실행 비트도 증거로만 기록하고 새 파일은 현재 대상 기본값을 사용합니다.
선택 코드·문서의 바이트를 옮기는 것이며 실행 환경·의존성까지 완성됐다는 뜻은 아닙니다.
재사용하면 현재 파일·권한을 그대로 유지하고 과거 버전과 같다고 주장하지 않습니다.

이름으로 식별하는 키·자격증명 저장소인 `.key`, `.p12`, `.pfx`, `.jks`, `.keystore` 등은
제외합니다. `.pem`과 `.asc`는 스트리밍 중 식별한 개인키 헤더를 거부하며 일반 공개
인증서 데이터는 보존합니다. 이 경로·형식 검사는 “비밀이 전혀 없다”는 인증이 아닙니다.
일반 선택 소스·문서와 `.env.example`에도 민감한 내용이 있을 수 있습니다. 사용자가
합의한 저장소 범위에서 파일을 선택하며 새로운 승인 양식을 요구하지 않습니다.

복사 대상을 묶음 자신이나 내부로 지정할 수 없으며 식별된 물리적 별칭도 보호합니다.
상위 폴더는 선택한 모든 출력과 임시 쓰기 부모가 보호한 묶음 밖일 때만 허용합니다.
명시적 재사용은 쓰지 않습니다. 대화 전달·재사용이 무관한 작업 폴더 객체를 다시
해시하거나 필수로 요구하지 않으며, 실제 복사할 captured 파일의 정확한 바이트만
검증합니다. 복사하지 않는 수동 증거인 지시 파일 객체는 복원을 막지 않습니다.
`workspaceObjectCoverage`가 검증·미검증 root와 객체 수를 표시합니다.
복사 시 `objectSelection`은 `restore-captured-only`이며, 검사하지 않은 지시 객체가 있는
root는 전체 검증 대신 `partiallyVerifiedSourceRoots`에 표시합니다.
그 호출에서 검사하지 않은 무결성은 미상이며 이전 실패를 해결한 것이 아닙니다.
일반 전체 묶음 조회는 계속 선언된 모든 작업 폴더 객체를 검증합니다.

실패의 `partialWorkspaceRestore`에는 원래 오류, 완료한 경로, 결과가 확정되지 않은
현재 경로와 아직 방문하지 않은 범위를 남깁니다. 권한 거부 후 덮어쓰기·rollback·
다른 쓰기 수단·추가 관찰을 하지 않습니다. 이 작업은 공통 Session을 import하거나
Project·에이전트 연동 지시를 재생성하지 않습니다. 원래 P2 복구에는 기존의 명시적인
공통 Session staging/import를 사용합니다.

### 캡처된 대화의 표시 이름

큰 물리 이력은 유한한 원본 구간의 비공개 캡처, 스트리밍 해시와 파일 기반 행
참조로 처리합니다. 전체 JSON 스냅샷의 512MiB 제한을 물리 이력 전체에 적용하지
않습니다. IO 버퍼는 1MiB이며 해석하는 JSONL 한 행의 제한은 64MiB로 유지합니다.
더 큰 행을 자르거나 건너뛰어 성공으로 처리하지 않습니다. 임시 캡처와 출력 파일은
아카이브가 소비한 뒤 또는 실패 시 정리합니다. `readCodexLiveProjectSource`를 직접
호출했다면 `finally`에서 `releaseCodexLiveProjectObservation`으로 해제합니다.
통합 live export는 이를 직접 처리하며 후속 작업은 완성된 아카이브를 재사용합니다.

작은 구간 읽기는 파일 소유 객체마다 최대 1MiB의 비공개 읽기 창을 재사용합니다.
매번 현재 권한과 루트·파일 신원을 확인하고 복사본을 반환합니다. 전체 청크 읽기와
최종 해시는 항상 실제 바이트를 다시 읽습니다. 한 번 실패한 소유 객체는 최초 오류를
유지하며 캐시가 이를 되살리거나 권한을 부여하지 않습니다.
기록 감사는 선택된 JSONL 바이트 구간을 순서대로 읽고 모든 행의 주소·해시와 현재
권한을 확인한 뒤 각 원본의 전체 해시를 새로 계산합니다. 물리 rollout이 다른 같은
ordinal을 합치거나 부모의 선택 범위 밖 미래를 읽지 않습니다. 선택적 JavaScript
prepare API는 마지막 검사를 마친 바로 그 객체를 같은 프로세스에서 재사용하도록
반환합니다. 기존 derive와 CLI/MCP는 요약만 반환합니다. 효과 실행 전에는 모든
원본·파생 파일 바이트와 현재 권한을 다시 검사합니다. 저장된 요약이나 다른 프로세스는
새 검사가 필요하며, 이 객체는 영속 검증 토큰이나 복구·실행 권한이 아닙니다.

실시간 내보내기는 묶음 처리 전후에 관측 전체를 검증하고 물리 패킷을 함께 준비합니다.
소스별 선택·계보·해시·현재 권한 검사와 최종 아카이브 검증은 유지합니다. 뒤 소스나
마지막 대조가 실패하면 앞 패킷도 반환하지 않습니다. 선택적 Host `onProcess`
관측은 프로세스 유실 뒤 정리를 위한 임시 파일의 정확한 소유 정보를 전달합니다.
이는 P5 운영 관측이며 복구 방향이나 일반 작업의 새로운 로그 작성 전제가 아닙니다.

별도 `codex-claude-physical-hybrid-v3` 변환은 정확한 생성 버전 `0.148.0-alpha.15`와
`0.149.0-alpha.4.3`의 설정 관측에서 thread ID가 기록되지 않은 경우만 지원합니다.
빠진 ID를 채우거나 설정을 현재 지시로 승격하지 않습니다. 명시된 잘못된·타 소유 ID,
최신 형식의 누락과 알 수 없는 설정 필드는 기존 거부·진단을 유지합니다. 이전 hybrid-v1/v2
자료는 원래 표현과 신원을 유지합니다.

정본 local-image 참조는 사용자 본문, 기록된 wrapper의 경로·번호·순서, 사용자 출처
content kind, 같은 소유자·turn, 인접한 원문 주소와 유일한 정확 wire 대응을 증명합니다.
해시 인덱스는 후보를 찾는 데만 쓰고 각 후보의 전체 원문 필드를 다시 비교합니다.
정본 참조 필드는 명시적으로 인용하고 캡처된 인라인 바이트는 원래 사용자 메시지에
함께 보존합니다. 과거 경로를 열거나 다운로드하거나 현재 파일과 같다고 추정하지
않습니다. 알 수 없거나 모호한 증거는 보존·진단하며 이미지가 없다는 표시로 바꾸지 않습니다.
PNG 무결성 검사는 유지합니다. JPEG는 baseline 8-bit 단일 interleaved scan,
1개 또는 3개 component와 검증된 quantization/Huffman table만 지원합니다. 모든
entropy-coded coefficient를 읽고 MCU 경계·byte stuffing·fill bit·정확한 끝을 검사합니다.
Progressive·restart 등 범위 밖 형식은 미검증으로 남깁니다. Raster를 할당하거나 바이트를
재인코딩하거나 provider 이미지 처리를 주장하지 않습니다. 공식 SDK와 실제 화면 검증은 별개입니다.

Hybrid-v6는 과거 도구 인자 문자열이 JSON으로 파싱되지 않아도 원문을 과거 데이터로
인용해 보존합니다. 입력을 고치거나 네이티브 도구 호출로 만들지 않으며, 당시 실행
결과도 추정하지 않습니다. v6에서 사용하는 strict reader는 해당 입력에만 원본 위치를 포함한 차단
진단을 남기고, v6의 이력 표시는 요청과 결과 원본을 보존합니다. 외부 JSON·UTF8·해시·
신원·권한·취소·숫자 정밀도 오류는 기존 처리를 유지합니다.
이전 hybrid-v1부터 v5까지의 표현과 오류 동작은 바꾸지 않습니다.
v6는 아래와 동일한 provider 안내 구조가 `0.148.0-alpha.15`에서 생성한 기록 저장소에도
관측된 경우를 추가로 인식합니다. v5의 기존 `0.153.4` 경계는 유지합니다. 저장소 생성
버전은 이후 모든 기록의 작성 버전을 증명하지 않습니다. 이를 근거로 개별 기록의 작성
버전이나 사용자 발언 여부, 현재 지시 권위를 추론하지 않습니다.

Hybrid-v5는 Codex `0.153.4`에서 관측한 provider 안내 구조를 추가로 인식합니다.
세 텍스트 조각에 `plugins.recommendations`, `agents_md.instructions`,
`environments.environment_context`가 순서대로 기록된 경우입니다. Wire 역할이
`user`여도 사용자 발언으로 재구성하거나 네이티브 지시로 옮기지 않고, 변경하지 않은
원본 동반 자료와 정확한 기록 원장에만 보존합니다. 최상위 필드는 ordinal/type/payload와
선택적인 timestamp 문자열만 허용합니다. 기록 종류·생성 버전·payload와
메타데이터의 정확한 필드와 타입·조각과 종류의 개수 및 순서가 모두 일치해야 합니다.
알 수 없는 필드나 사용자·비공개 콘텐츠 종류가 섞인 구조는 여전히 미지원으로 남습니다.
이전 hybrid-v1부터 v4까지의 출력과 신원은 그대로 유지합니다.

Hybrid-v4는 이전 hybrid-v1/v2/v3의 출력과 신원을 유지하면서 과거 기록의 표현을
버전별로 추가합니다. 생성 버전 `0.148.0-alpha.15`와 `0.149.0-alpha.4.3`의
assistant wire ID가 달라도 물리 소유자·기록된 turn·그대로의 phase·검증된 전체
본문 투영이 같고 정본 후보가 유일할 때만 대응시킵니다. 정본은 ordinal과 바이트
순서 모두에서 wire 바로 앞이어야 하며, 일대일 사용과 원래 순서를 검사합니다.
메시지 ID를 바꾸거나 동일한 ID라고 주장하지 않습니다. 모호함은 일치가 아닙니다.

정본과의 관계를 증명할 수 없는 알려진 구형 user 전송은 관계 미확인인 과거 provider
자료로 명시하여 보존하며, 재구성한 사용자 입력으로 귀속하지 않습니다. 생성 버전
`0.148.0-alpha.15`에서 `unknown` content kind가 기록된 제한된 assistant 전송도
원문 전용 reasoning 기록 바로 뒤에 있을 때 미확인 인용으로 보존할 수 있습니다.
Reasoning 자체는 가져오지 않습니다. 임의의 미지 content kind·role·provenance·필드나
암호화 본문을 허용하는 규칙이 아닙니다. Native 인용은 과거 assistant 자료로 표시하며,
본문 표지·inventory·coverage에서 정본 발화, 현재 답변, 승인, 복구 방향과 구분합니다.
인용 안에 과거 지시 문자열이 있을 수 있지만 현재 지시로 적용하지 않습니다. 정본 발화의
전체 포함 증명만으로 추가 전송 기록의 정본 귀속을 증명한 것은 아닙니다.

생성 버전 `0.148.0-alpha.15`·`0.149.0-alpha.4.3`·`0.153.4`에서 관측한
`personality`와 `orchestrator_skills` 설정 구조는 원문 전용으로 유지합니다.
`0.148.0-alpha.15`와 `0.163.0-alpha.10.2`의 알려진 실패 `DynamicToolCall` 구조는
status·success·error·duration을 포함하여 과거 원문 그대로 인용합니다. 새로운 native
도구 호출이나 실행 성공으로 바꾸지 않습니다. 알 수 없는 필드와 검증되지 않은 표현은
원문을 보존하고 진단합니다.

같은 프로세스의 검사 완료 객체는 지연 본문을 평가하지 않고 메타데이터·mapping·행·
callback을 불변화합니다. 게시에는 비공개로 등록된 원래 검사 객체만 사용할 수 있으며,
복제본·JSON 요약·교체한 callback은 사용할 수 없습니다. 효과 직전 재검사는 현재 파일과
파일에서 분리된 작은 Buffer 바이트도 확인합니다. 이 동일성 검사는 권한을 부여하지
않습니다. 다른 프로세스는 원본을 다시 검사합니다. 대상 경로는 JSON 직렬화와 공식
native handoff로 전달하며, 실행 중인 Desktop 등록 파일을 직접 수정하지 않습니다.

실시간 물리 수집의 `CodexSelectedHistoryAddressEvidence`는 선택한 typed 주소와
projection watermark입니다. Canonical DB의 전체 항목 본문을 중복 수집한 것이
아닙니다. 본문 원본은 검증된 물리 구간이며 DB 본문과의 등가성을 주장하지 않습니다.
오프라인 전체 canonical 수집은 기존의 별도 경로로 유지합니다. 파일명 끝은
`-<physical UUID>.jsonl` 또는 `_<physical UUID>.jsonl`을 허용하되, 선택한 논리 상태·헤더
신원·조상 구간의 정확한 바이트·ordinal·해시를 계속 검증합니다. 과거 paginated
생성 버전 `0.148.0-alpha.15`·`0.149.0-alpha.4.3`·`0.153.4`에도 명시적인 형식 검사를 적용하며,
설치된 SQLite 프로필의 검증을 완화하지 않습니다.

명시적으로 선택된 `.jsonl.zst` 조상은 공식 Node Zstd 스트림으로 처리합니다.
디코더 윈도와 작업의 공통 기한을 유지하고, 요청한 복원 구간의 LF·ordinal·cutoff와
실제로 읽은 압축 입력 범위의 해시·동일성을 대조합니다. 파일에서 미리 읽힌 바이트와
디코더가 소비한 바이트를 구분합니다. 압축 원본은 소스 위치에서 보존하고 압축 파일
전체나 복원된 부모 대화의 미래 구간을 아카이브에 복사하지 않습니다. 저장된 구간은
원래 비압축 파일이 아닌 `zstd-decoded-selected-prefix`로 표시합니다. 중간 종료는
압축 프레임·컨테이너 전체 체크섬 검증이 아닙니다. 아카이브 조회는 저장 구간의
바이트·계보·typed 인코딩 기록을 검증하며, 저장하지 않은 압축 원본으로 오프라인
재현했다고 주장하지 않습니다. 권한·취소·디코더 오류는 의도한 구간 종료와 구분해
유지합니다. HEAD가 발견한 정확한 압축 파일명을 기존의 명시적 조상 범위에 넣으며,
사용자가 JSON을 작성하거나 파일 이름을 바꿀 필요는 없습니다.

Lode의 파일 기반 처리가 공식 Claude SDK까지 스트리밍으로 바꾸지는 않습니다.
SDK 0.3.234는 offset/limit 적용 전에 선택한 대화를 전체 읽고 재구성합니다.
실제 출력은 감독되는 프로세스에서 고정된 공식 reader로 검증하고 자원·형식 실패를
별도로 보고합니다. 작은 SDK 페이지, 아카이브 생성, Lode 해시 일치만으로 SDK 성공·
Desktop 표시·모델 이어쓰기를 주장하지 않습니다.

Physical-v3·hybrid-v2·hybrid-v3 변환은 캡처된 selected-state의 name을 목록 제목으로 사용하고 공식 SDK와 동일하게 앞뒤 공백만 제거합니다. 긴 이름이나 중복 이름도 허용합니다. 이름이 없으면 일반 제목과 원본 ID를 사용합니다. 첫 질문에는 민감한 입력이 있을 수 있으므로 대체 제목으로 사용하지 않습니다. Native ID와 기록된 fork 계보는 별도 출처 정보로 유지합니다.

기존 physical-v1/v2·hybrid-v1은 원래 바이트와 재현 규칙을 유지합니다. 제목 정책이 바뀌어도 이미 전달한 대화를 새 ID로 다시 게시하지 않습니다. 기본 변환은 기존의 정확한 프로필을 재사용하며, 여러 프로필이 존재해 불명확한 경우에만 정확한 기존 대상을 선택해야 합니다.

명시적으로 승인된 보정에서 proposeClaudeDerivedTitle은 재현 검증된 아티팩트와 typed 원본 증거에서 이름을 가져옵니다. 비공개 P3 계획은 권한이 아닙니다. correctClaudeDerivedTitle은 현재 Host 권한과 기존 목적지 admission을 확인하고 목적지 전역 P5 create-only 명령 기록과 일회용 실행 증표를 사용합니다. 공식 SDK 0.3.234 renameSession으로 같은 대화에 제목 메타데이터를 덧붙입니다. 이관된 구간·호출 전 전체 구간·파일 동일성·메시지·현재 제목을 검증합니다. 앱의 일반 메타데이터 추가는 허용하고 다른 작성자가 제목이나 본문을 바꿨다면 덮어쓰지 않습니다. 실행 시도 후 완료 결과가 없으면 불확실하게 남기고 자동으로 재실행하지 않습니다.

보정 후 SDK 제목은 원본 이름 보정 영수증과, 본문은 기존 불변 변환본과 각각 비교합니다. 모델 대화를 시작하거나 Product·Session/P2·실행·복구 권한을 만들지 않습니다.

SDK는 비협조 작성자에 대한 compare-and-swap을 제공하지 않습니다. 변경 구간에 경쟁 제목 기록이 끼어들면 성공으로 보고하지 않고 불확실하게 남깁니다. 실행 기록 없는 결과 기록은 실제 변경 전에 거부합니다.

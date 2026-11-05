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

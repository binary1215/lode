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

## 선택적 Codex 네이티브 이력

이 기능은 별도의 실험적 Host 어댑터이며 **Codex의 안정적인 공식 import API가
아닙니다.** 일반 Project·Session 복구는 독립적으로 사용할 수 있습니다. 첫 검증 조합은
Windows x64·Codex 엔진 `0.166.0-alpha.5.1`이며, DB 스키마·마이그레이션·원본 이력
형식을 정확히 검사합니다. 버전 문자열만 같다고 지원하지 않습니다. 모르는 네이티브
조합에서도 공통 번들의 보관·조회는 가능하지만, 네이티브 쓰기를 지원한다고 하지 않습니다.

공개 작업은 `lode_project_native_history`이며 CLI는 다음과 같습니다.

```sh
node scripts/lode.mjs project-native-history "<bundle>" --action capture --native-home "<source-CODEX_HOME>" --executable "<exact-codex.exe>" --threads "<explicit-native-id,...>"
node scripts/lode.mjs project-native-history "<bundle>" --action read
node scripts/lode.mjs project-native-history "<bundle>" --action restore --native-home "<target-CODEX_HOME>" --executable "<exact-codex.exe>"
node scripts/lode.mjs project-native-history "<bundle>" --action register --native-home "<target-CODEX_HOME>" --executable "<exact-codex.exe>" --runtime-root "<current-workspace>"
```

각각 별도로 요청하는 효과입니다. 일반 개발 전에 이 명령들을 순서대로 실행할 필요는
없습니다. 데이터 조회에는 기존 읽기 전용 `lode_project_bundle_read`의
`include_native_history: true`를 사용합니다. SDK를 시작하지 않으며, 공통 결과와 선택적
네이티브 오류를 분리해서 보여 줍니다.

캡처와 raw·SQLite 복원에는 쓰기 프로세스가 멈춘 창을 실제로 관측해야 합니다. Lode가
앱이나 기존 MCP 연결을 종료·재시작하지 않습니다. 관련 writer가 불명확하면 네이티브
작업만 사용할 수 없으며 Core 복구는 계속됩니다. 현재 대화가 자기 앱을 닫은 뒤 그대로
실행을 이어가는 구조는 아닙니다. 이관을 준비하고, 사용자가 선택한 오프라인 창에서
CLI로 진행합니다.

캡처는 선택한 원본 바이트, 원래 파일명, 타입을 보존한 이력 행을 담습니다. 64비트 정수,
BLOB, NULL, 알 수 없는 JSON 필드도 보존합니다. SQLite가 읽는 commit된 WAL을 사용하며,
source WAL·SHM이나 source DB 전체를 전송하지 않습니다. 선택한 과거 state는 계정 선택
열을 제외한 역사적 근거이며, 대상 state 행이나 현재 권한 설정으로 적용하지 않습니다.
옛 절대경로도 역사적 정보로 남습니다. fork·history-base·압축·회전·보관 이력은 각각의
closure·형식 검증 한계를 유지합니다. 보존했다고 네이티브 복원이 검증된 것은 아닙니다.

create-only `native-history.json`은 정확한 공통 번들과 선택한 네이티브 payload를
연결합니다. P3 이관 근거이며, **이 Lode Session이 해당 네이티브 대화를 소유한다는
증명은 아닙니다.** 명시적인 선택이나 별도로 검증된 Host 경로를 사용하고 제목·최신
순서로 소유를 추정하지 않습니다. runtime binding·checkpoint·ReviewDecision·Canon·실행
권한을 만들지 않습니다. 연결 파일의 부재·부분 복사·손상은 네이티브 결과의 문제이며,
공통 manifest는 바뀌지 않습니다.

복원은 검증된 대상 이력 DB의 로컬 사전 백업 뒤, 없는 정확한 raw 파일과 선택한 이력
행만 추가합니다. state DB 교체, `INSERT OR REPLACE`, 이후 사용자의 변경을 전체 백업으로
덮어쓰기, 대상 설정 변경은 하지 않습니다. 파일 게시와 SQLite 트랜잭션은 별도 경계이며,
앱 시작이나 source·target의 변경이 감지되면 의존하는 후속 작업을 중단합니다.

디코더 한도를 넘는 큰 frame도 원문 바이트로 스트리밍해 보관합니다. 최종 바이트 길이가
선택한 cutoff와 같아야 하지만, 한도 이후의 frame 경계와 의존성은 미검증으로 남습니다.
캡처나 재조회가 이를 네이티브 게시 지원으로 승격하지 않습니다. ID·권한·잘못된 형식·
cutoff의 오류는 원래 실패를 유지합니다.

## 등록과 실제 검증 한계

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

| 검증한 정책·조회 | 고정 SDK에서 확인한 결과 |
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

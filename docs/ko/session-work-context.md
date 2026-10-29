# Session 작업 맥락과 Host 연속성

> [영문 원문](../session-work-context.md)

[한국어](session-work-context.md)

일반 조사와 직접 수정에는 Run이나 저장 의식이 필요하지 않습니다. Lode는
의미 있는 인계·맥락 유실 경계에서 필요한 내용을 보존하고, 같은 논리 Session의
진입에서 선택된 원본을 다시 구성합니다. 전체 대화 복구나 저장하지 않은 내용의
무손실 보존을 보장하는 기능은 아닙니다.

## 무엇을 누가 보존하나요?

현재 공통 방향은 ProjectDirection이 소유합니다. Session 한정 목적·제약·취소는
기존 Session 목적과 최신 checkpoint의 명시적인 P2 방향에 남깁니다. 공유
Project 갱신이나 P3 메모로 대신하지 않습니다. 예를 들어 “로컬 조사만, 네트워크
금지”를 목적·명시 결정에 보존하고, 이후 checkpoint에서 이전 재작성 제안을
“재작성 취소, 설명만”으로 바꿀 수 있습니다. 다른 Session은 변하지 않습니다.
이 텍스트의 작성·해석은 Lode의 몫이며 Core는 단어에서 승인을 추출하지 않습니다.
과거 결정이나 다음 단계는 현재 실행 권한이 아닙니다.

먼저 기존 checkpoint·결과·검토·소스 원본을 재사용합니다. 거기에 없는 판단 이유,
기각한 대안, 선택된 관찰, 미완료와 불확실성만 작은 Session 소유 P3 Evidence로
보완합니다. 과거 제안으로 복구 필드를 채우거나 작업을 승인할 수 없습니다.
기존 Evidence 평면의 하위 유형이지, 두 번째 방향 저장소·이력 문서·전역 기억 DB나
상주 서비스가 아닙니다.

## 가벼운 보존 경로

### Session·선언된 작업 root·작성된 주제

의미 있는 완료·인계·조건 변경에서 Lode는 기존 두 writer로 실제 소비 경로의 결과,
판단 이유·대안, 남은 일과 불확실성을 보존할 수 있습니다. 선택적 `workTopics: string[]`는
작성된 탐색 라벨이며 Product 온보딩이나 사용자 분류표가 필요하지
않습니다. 라벨만으로는 의미 있는 작업 근거가 되지 않습니다. 필드가 없으면 정규화
원본에서도 생략되어 기존 ID·digest·정확 재시도 바이트가 같습니다. 주제 텍스트에는
기존 전체 record 크기만 적용하며 별도 라벨 개수 gate는 추가하지 않습니다.

주제에만 있는 단어로도 그래프의 실제 본문을 찾을 수 있고, 경로·anchor·이웃 조회도
같은 원본을 사용합니다. 라벨은 Product Feature·IMPLEMENTS/VERIFIED_BY·승인·완료나
복구 지침을 만들지 않습니다. 이미 검토된 Product 관계는 정확한 revision 계약을
유지합니다. 부분 그래프의 주제는 `workContentExcerpts`의 원본 field/index/range로
표시하며 빠진 항목을 조용히 재번호화하지 않습니다.

기본 CLI/MCP 텍스트는 반환된 실제 본문을 정확한 Project/Session과 선언된 root의
ID 및 digest별로 묶습니다. 연결 없는 기록은 독립적으로 남고, 중첩 anchor를
전이적으로 합치지 않습니다. 같은 라벨의 여러 Session/root도 소유자가 다르며,
다중 라벨이 저장 원본이나 본문을 복제하지 않습니다. reader/entry의 선택적
`selectedBodyGroups`는 반환 record index를 가리키고 실제 내용은 `records`에 한 번만
있습니다. scope·생략 안내·직렬화 wrapper를 포함한 추가 정보는 record 예산의 남는
공간만 사용합니다. fitting 본문이 우선이며 group 정보 부재는 작업 부재가 아닙니다.
`omittedGroups`는 view group의 생략 수이지 원문 생략 수가 아닙니다. `max_characters`는
record/발췌 전달의 상한이지 전체 reader/MCP 전송 상한이 아닙니다.

startup은 실제로 출력에 담은 record의 index로 group을 만들고 Host별 최종 전체 JSON
상한을 검사합니다. 현재 지침·목적·checkpoint·fitting 본문이 선택적 정보보다 우선합니다.
추가 조회·쓰기·선택 변경·전체 이력 조사·필수 도구 순서나 저장/시작/종료/ID 의식은
없습니다. 과거 ended와 실제 결과·남은 검증·unknown은 공존하며 서로 지우지 않습니다.
이 정리는 native 자동종료·ancestry·실시간 활동판정을 구현하지 않습니다. 로컬 fixture와
지침 검사는 실제 Host 전달이나 모델 준수의 증거가 아닙니다.

- checkpoint 동기화가 이미 유용한 경우 Lode는 기존 `lode_checkpoint_sync`
  요청에 선택적인 `work_evidence`를 함께 넣습니다. P2와 P3 결과는 별개입니다.
  stale·deferred checkpoint 때문에 근거가 방향으로 승격되지 않으며, 선택적
  근거 저장 실패가 유효한 명시적 P2 게시를 막지도 않습니다.
- checkpoint가 불필요한 의미 있는 작업에는 선택적 `lode_session_work_record`
  한 번으로 Run 없는 맥락을 보존합니다. Lode가 대화에서 필요한 항목만 작성합니다.
  사용자는 JSON·ID·저장 승인·Run·Capsule을 준비하지 않습니다.
- `lode_conversation_enter`는 선택된 Session의 원본과 P2 방향을 현재 공통
  제약·취소와 함께 읽습니다. 쓰기는 없으며 선택적 근거의 누락·손상은 해당 계층만
  제한합니다.
- `lode_session_work_read`로 알고 있는 정확한 원본이나 명시적 ID anchor의 조회
  페이지를 펼칩니다. 필요에 따른 확대이지 의무적인 도구 호출 순서는 아닙니다.

이미 저장한 작업도 기존 `lode_project_graph` 탐색에 나타납니다. 질문·경로·anchor·
이웃 조회에서 검증된 실제 소유 Session별 이유·대안·관측한 작업·남은 일·불확실성을
읽을 수 있습니다. 그래프 탐색은 Project 범위이며 native 연결이나 Session 전환이
필요하지 않고, 선택된 Session의 진입이나 현재 P2 방향을 대체하지 않습니다.

작고 fitting인 `workContent`는 short 결과에서 바로 활용합니다. 단일 작업 결과는
탐색 노드와 함께 큰 이유의 완전본문을 보일 수 있고, 큰 다중 원본 결과는 생략한
내용과 실제 원문 구간을 밝힙니다. 표시된 값을 완전한 것으로 사용하기 전
`workContentCoverage.partial`을 확인합니다. `originalExpansion`은 기존 정확 reader에
실제 소유자 한 명과 enriched record에 필요한 크기를 사용합니다. 확장 후 반환된
identity와 digest를 확인하며 그래프 탐색 이후 변경 가능성을 유지합니다. 이를 위해
새 저장·승인·도구 순서나 사용자 작성 ID를 요구하지 않습니다.

기본 text에서 정확히 알려진 정상 projection flag와 역사적 범위 설명은 한 번만
보여줍니다. `selectedBodyGroups` 전체가 실제 반환 record로 표시한 그룹과 정확히
같고 생략이 없을 때만 중복 envelope 표시를 뺍니다. 부분 그룹·예상 외 값·새 필드·
소유자·원문·참조 검사·coverage·정확 확대는 각 범위에 남깁니다. 이는 text 표시
정리이며 structured/JSON 결과와 startup serializer는 바꾸지 않습니다.
미열거 inventory(`originals: null`)를 이력 없음으로 취급하지 않습니다.

기본 CLI/MCP text는 반환된 맥락을 바꾸지 않고 읽기 쉽게 배치합니다. 진입에서는
현재 공통 방향, 선택된 Session의 유효한 목적과 검증된 checkpoint 맥락을 과거 작업보다
먼저 보여줍니다. 작업 본문 앞에는 실제 상태·소유자와 과거/부분 범위를 짧게 알리고,
각 판단의 assessment·이유·대안은 함께 둡니다. formatter가 원문 값을 요약하거나
다시 자르지 않습니다. 미지 key와 빈 값을 포함한 추가 필드는 원래 객체 위치에
남깁니다. identity·참조 진단과 나머지 상세는 해당 본문 뒤에, coverage·생략·지원되는
확대 안내는 이를 담은 맥락에 이어 표시합니다.

이는 기본 text의 표시만 바꿉니다. Core 값, MCP `structuredContent`, CLI `--json`,
Hook, 선택과 proof 검사는 그대로입니다. 완전한 반환 본문은 변경된 참조나
`sourceFallback`이 함께 있어도 활용할 수 있으며, 그 존재만으로 자동 재조회를
요구하지 않습니다. 빠진 내용이나 현재 소스에 의존하는 판단에는 공개된 정확한
확대 또는 해당 소스 확인이 필요할 수 있습니다. 과거 내용은 현재 효과 권한이
아니며, 실제로 비어 있는 정상 진입은 조용히 유지합니다.

자체완결적인 [lode-conversation Skill](../../skills/lode-conversation/SKILL.md)은
Lode 작업·선택·진행·결과를 사용자 언어로 설명하도록 돕습니다. 일반적인 implicit
Skill 발견에 참여하지만 Core 실행·복구·권한 보호의 전제는 아닙니다. 로컬 패키지
검증은 동봉한 bytes를 확인할 뿐 설치나 실제 Host 선택을 증명하지 않습니다.

확인된 생성 안내문·역할·공급자 설정의 차이는 그대로 표시하되 정상인 선택
Session의 복구나 작업 맥락 조회를 막지 않습니다. 진입은 수정·누락된 투영을
복구하지 않습니다. 투영 갱신·변경 보호는 원본 identity·digest·계보 검증과
분리됩니다. 관리 원본의 drift, 미분류 관리 경로, 읽을 수 없는 manifest를
투영만의 차이로 허용하지 않습니다. 유용한 일반 작업 맥락에 checkpoint는
필수가 아닙니다.

정확히 지정한 정상 by-id Session은 무관한 기본 Session이 누락·손상되어도
조회할 수 있습니다. 그 기본 Session에 의존하는 선택적 Product 정보는
확인 불가로 남으며 작업 계속의 전제가 아닙니다. 실제 기본 Session 요청,
선택 Session 손상, 확인된 중복 identity, 다른 Project 소유는 다른 Session으로
대체하지 않고 거부합니다. 조회는 포인터를 고치거나 전환하지 않습니다.

### 공통 방향의 연결이 유실된 경우

방향 포인터가 없더라도 원본 revision이나 식별 가능한 저장 중단 staging이 남아
있으면 빈 방향으로 처리하지 않습니다. 진입은 공통 방향만 확인 불가로 표시하고,
독립적으로 검증된 checkpoint와 작업 근거는 유지합니다. Lode는 저장·수리·승인
절차를 추가하지 않고 독립 작업을 계속합니다. 현재 방향에 의존하는 효과와
checkpoint CAS는 계속 엄격하게 검사하며, 과거 결정·다음 작업으로 현재 제약이나
취소를 대신하지 않습니다. 기존 continuation 검사는 일회용 token 소비 전에 수행합니다.

식별 가능한 원본·staging 없이 빈 디렉터리만 있으면 기존 미사용 상태를 유지합니다.
이름·시각·유일한 revision으로 현재 방향을 고르지 않으며 조회가 포인터를 쓰지도
않습니다. 모든 흔적이 삭제됐다면 추가 증거 없이 미사용과 구별할 수 없습니다.
원본 무결성·경로 오류는 가용성 예외로 숨기지 않습니다. 순차 관찰은 원자적이지 않습니다.

embedding CLI의 `metric-status`는 caller 선택이 유실돼도 MCP peer와 같은
Project-only 분류를 사용합니다. 기존 readiness 검사는 유지하며 라우팅이 default를
고르거나 Host binding을 고치지는 않습니다.

짧은 작업은 추가 기록을 만들지 않습니다. 동일한 선택 입력은 원본 바이트를
재사용하고, 정말 다른 반복 관찰은 Lode가 사건 구분을 붙일 수 있습니다.
중복 제거는 효과 발생의 증명이 아닙니다. 다른 판단은 마지막 작성자로 덮지 않고
별도 근거로 남깁니다. 재시도는 저장만 보완하며 코드·provider·외부 효과를 반복하지
않습니다. 지원되는 보존 경계 전에 갑자기 종료되면 미저장 내용은 유실될 수 있습니다.

## 범위, 원본과 불확실성

### 연결된 맥락과 저장된 활동 관측

기존 두 선택적 근거 입력은 `workLink: {root, predecessor}`와
`executionObservation: {state, target?}`을 받습니다. 각 selector는 같은 Project와
선택 논리 Session에 실제 보존된 원본의 `{evidenceId, evidenceDigest}`입니다.
상태는 `running`, `paused`, `ended`, `unknown`입니다. Lode가 기존의 의미 있는
보존 경계에서 필요한 경우에만 내부적으로 공급합니다. 별도 시작·종료·저장 호출,
사용자 ID 양식이나 승인은 필요하지 않습니다. 관측 자체는 의미 있는 근거일 수
있지만 연결만으로는 작업 내용을 보존한 것이 아닙니다.

root는 명시한 최초 보존 anchor이지 실제 작업 시작의 증거가 아닙니다. predecessor는
그 정확한 root이거나 동일 root를 선언한 기존 원본이어야 합니다. 이미 연결된 원본도
새 anchor가 될 수 있으며 이전 provenance를 지우거나 두 맥락을 합치지 않습니다.
새 쓰기에서 endpoint를 검증하되 동일 재시도는 endpoint·소스가 이후 소실돼도 자기
원본이 정상이라면 먼저 재사용합니다. 새 필드가 없으면 기존 정상화 바이트·ID·프로토콜이
그대로입니다. migration이나 별도 활동 registry는 없습니다.

이것은 저장된 메모에 관한 관측이지 실행 attempt identity가 아닙니다. 동일 exact
target의 여러 상태는 역사로 공존하며 시각·predecessor로 현재 승자나 실행 충돌을
정하지 않습니다. E1의 `ended`가 이후 E3·sibling·메모에 언급한 모든 실행·남은 일·필수
리뷰를 닫지 않습니다. 실패·취소는 성공이 아닙니다. target 없는 관측은 다른 메모를
정돈하지 않습니다. 현재 live 상태·미저장 재개·native Session 종료는 미관측입니다.
삭제·숨김·자동 정산·실행 재시도는 하지 않습니다.

기본 조회의 `selectionRole`은 최근·명시 인용·선언 root 본문을 구분합니다.
`savedActivity`는 incoming 역사 상태 집합과 제한된 exact qualifier selector·개수,
관계 가용성을 보존합니다. 자기 관측은 원본 `content`에 그대로 남습니다. 별도
`organization` 안내가 역사이지 live가 아님을 한 번 설명합니다. `organization.scope`는
실제 반환한 source 원본의 수치 범위이며 전체 이력의 조직 통계가 아닙니다.
incoming qualifier 개수는 이번 요청에서 실제 검증한 알려진 producer 범위입니다. 누락·변경 관계는
해당 뷰만 제한하고, 선택 재읽기에서 실제 확인한 실패는 같은 응답의
의존 overlay·endpoint 진단·typed reference에도 부분 상태로 반영합니다.
표시 target의 알려진 모든 incoming producer는 반환 기록 수만큼의 prefix가 아니라
자기 원본·owner와 exact target을 canonical 검증합니다. incoming-only producer의
무관한 링크·일반 참조나 그 producer 자신의 incoming까지 재귀 검사하지는 않습니다.
본문이 아닌 producer가 그 검사 이후 바뀌어도 반드시 다시 읽지는 않습니다.
유지된 projection은 검사 시점의 과거 관측이지 반환 순간까지 원본 bytes가
정상이라는 증명이 아닙니다. 실제 본문과 직접
사용한 선언 endpoint는 계속 fresh 검사합니다. 이후 실제 관측한 실패가 우선하며
미관측 변경과 ABA는 보장 밖입니다. exact-ID나
page 조회는 숨은 조상이나 qualifier를 추가 검색하지 않으며 미검사를 부재·종료로
단정하지 않습니다.

기본값은 최근 seed, 같은 Session 작업 원본의 한 단계 명시 artifact 인용과 선언된
root를 recent → cited → root 순으로 섞습니다. 최소 절반의 슬롯을 최근/fallback
선택에 남기고 원본 본문은 중복하지 않습니다. 한 슬롯이면 최근만, 두 슬롯이면 root보다
인용 본문을 먼저 시도합니다. 의미 eligibility 게이트가 아니라 제한된 표시 배분입니다.
큰 anchor가 맞지 않아도 최근 결과·남은 일은 계속 후보입니다. reference의 `digest`는
파일 바이트 해시로 원본 `evidenceDigest`와 다릅니다. 인용은 실제 판단 이유 본문이지
새 요약이나 경로를 복구 내용으로 제시하는 것이 아닙니다.

추가 관련 본문 확대 시도는 실패·oversized를 포함해 `maxRecords` 이하입니다.
이 상한은 unknown 원본 검사나 필요한 직접 endpoint 검증의 상한이 아닙니다.
표시 target마다 모든 incoming producer를 다시 읽지는 않습니다.
중복 읽기 방지용 proof metadata를 유지하며 검증된 큰 후보도 별도의 부분 발췌를 제공할 수 있습니다.
선택/관련 본문만 제한적으로 유지하며 전체 역사를 상주시키지 않습니다. 관련 확대
보류 수와 고유 원본 예산 생략 수는 별개라 합산하지 않습니다. 연결 확장이 없어도
recent/related/fallback 정책은 같으며 무관한 옛 확장이 슬롯 정책을 바꾸지 않습니다.
연결 없는 이력은 남은 슬롯을 최신 우선으로 채우고 명시 page/cursor는 바꾸지 않습니다.

작업 원본은 선택된 Session의 `work-evidence/` 디렉터리에 있습니다. 필수 index나
cache는 없습니다. 기본 진입/조회는 그 디렉터리의 이름·type 집합을 고정합니다.
기존 graph index의 선택적 navigation은 과거 순서와 observation target 힌트를
제공할 수 있지만 작업 본문이나 현재 validity 판정은 담지 않습니다. usable hint가
없는 이름은 같은 요청에서 canonical 검사하고 선택 전에 합류합니다. index가 없거나
legacy·사용 불가이면 발견 집합의 canonical 검사로 되돌아가며 index 수리·필수 refresh나
일반 작업 중단을 요구하지 않습니다. 실제 본문 후보와 직접 사용하는 선언
root/predecessor/observation endpoint는 계속 fresh 검사합니다. 유효한 원본이 실제로
관측한 과거 힌트와 다르면 손상으로 버리지 않고 그 고정 발견 집합에 한 번 canonical
fallback합니다. 현재 검사들 사이에서 나중에 관측한 실패는 계속 실패입니다.
후보는 기록 시각 내림차순, 동시각이면 evidence ID 순으로 고려합니다. 기본 출력은
전체 기록 또는 발췌로 최대 여덟 고유 원본을 반환하며 의미적 관련성·충분성·현재 권한을 판정하지 않습니다. 손상되거나
너무 큰 후보 뒤에도 들어가는 정상 작업을 계속 고려합니다. 자동 정리·조용한 삭제·
필수 전체 이력 감사는 없습니다.

기본 `coverage.originals`는 고정한 발견 ID 집합 수이고, `coverage.inspected`는 그중
이번 요청에서 실제 canonical 검사를 시도한 고유 원본 수입니다. 확정된 읽기·JSON·
검증 실패도 포함합니다. 과거 hint-only 원본을 현재 `coverage.valid`에 넣지 않습니다.
`omissions.uninspected`는 두 수의 차이이며 본문 예산 탈락이 아닙니다. 예를 들어
독립된 fitting 원본40개에 정상 힌트가 있으면 본문8개·inspected/valid8·uninspected32를
반환할 수 있고, 같은 원본에 no/legacy index이면 inspected/valid40·uninspected0입니다.
실제 body admission 거절이 없다면 양쪽 모두 `omissions.byBudget`은0입니다.
어느 결과도 모든 본문 제공·의미적 충분성·반환 순간 최신 상태를 증명하지 않습니다.
이후 관측한 실패는 같은 ID를 한 번 재분류합니다. 디렉터리 발견 뒤 처음 나타난
endpoint는 정확한 proof-only 의존성으로 검증할 수 있지만 같은
응답의 발견/body 집합이나 수에 넣지 않습니다. 다음 요청에서 정상 발견할 수 있습니다.
`nextAfterEvidenceId: null`은 기본 ID-page cursor가 없다는 뜻입니다. 미검사 원본이
남거나 valid가 included보다 많으면 기존 `work_context_partial`로 부분 본문 전달을 표시하며 복구 실패·오류·사용자
조치 gate가 아닙니다. 유용한 exact 확대는 선택적이며 자동 전체 감사를 요구하지 않습니다.
아는 `evidenceIds`는 Session inventory를 열거하지 않고 정확히 펼칠 수 있습니다.
이때 `coverage.originals`와 `omissions.uninspected`는 `null`,
`nextAfterEvidenceId`도 `null`입니다. inspected는 중복 제거한 요청 집합이지 Session
전체 수가 아닙니다. 빈 exact 결과는 요청 ID 범위일 뿐 Session 이력 부재가 아닙니다.
명시한 non-null
`afterEvidenceId`는 기존 lexical ID 검사 페이지(최대512)와 다음 cursor·페이지 안의
시각 정렬을 유지합니다. 전역 시각 순 cursor나 완전 ID 발견 인터페이스는 아닙니다.
숫자 `coverage.originals`는 계속 발견 inventory 크기이며 끝난 페이지는 그 페이지의
결과이지 Session 이력 부재가 아닙니다. text는 관측한 숫자 `coverage.originals`가
`0`일 때만 조용히 유지하며 inventory 미관측을 빈 이력으로 바꾸지 않습니다.
제한된 생략 ID 샘플에 모든 누락 ID가 나타나지는 않습니다.

시작 ID를 임의로 만들지 않고 첫 사전순 페이지를 읽으려면 `scanEvidence: true`
(MCP `scan_evidence: true`, CLI `--scan-evidence`)를 지정합니다. 첫 페이지는 실제
`nextAfterEvidenceId`와 다음 한 번의 요청에 쓸 `enumeration.next` 인자를 반환합니다.
실패·크기 초과 원본도 검사 범위에 포함해 cursor가 같은 파일에 멈추지 않으며,
다음 페이지는 앞 페이지 본문을 다시 읽지 않습니다. 목록은 요청마다 관측하므로
cursor 앞 삽입은 놓칠 수 있고 마지막 페이지가 전체 이력 완전성이나 방향을 뜻하지
않습니다. 기본 최근 선택·exact ID 조회·P2를 바꾸지 않는 선택적 읽기입니다.
명시적 scan은 본문 용량과 기존 생략·실패 selector 32칸이 차면 512개 전에 멈출 수
있습니다. 검사한 원본은 모두 본문 또는 반환 목록의 정확한 ID로 확인할 수 있고,
다음 frontier는 ID조차 알리지 않은 원본을 건너뛰지 않습니다. 이 새 scan 모드는
사전순으로 담으며 scan 없는 기존 `afterEvidenceId` 페이지 규칙은 유지합니다.
Todo 인자는 별도 투영을 요청하며 scan 플래그만으로 독립 Todo 이력을 추가 검사하지
않습니다.

과거 힌트는 교체 가능한 P4 metadata이지 현재 archive census가 아닙니다. 미선택
same-name 외부 복원, 그럴듯하지만 잘못된 순위나 미관측 false-null observation target은
발견하지 못할 수 있습니다. 알려진 incoming 상태가 가능한 모든 상태는 아니며 직접
관계 검증이 전역 acyclic 증명도 아닙니다. 현재 목적·공통 제약·취소·P2·효과 권한은
별개입니다. 자동 전체 감사나 새 사용자 모드를 요구하지 않습니다.

디렉터리 발견은 여전히 모든 해당 이름·type을 확인합니다. 작은 metadata는 O(N),
정렬은 O(N log N)이며 기존 Project index 전체 읽기·decode·parse는 다른 Session·layer를
포함한 bytes·entries·dependencies·navigation rows에 비례하는 비용을 추가합니다.
usable hint가 있으면 원본 I/O는 unknown·실제 본문 시도·직접 endpoint·알려진 incoming
producer·일반 참조에 따라 달라집니다. 힌트 누락·fan-in·oversized fallback·관측한 힌트
모순은 여전히 N개 전부를 검사하게 할 수 있습니다. 보편적인 속도 개선이나 freshness
보장이 아닙니다. 정상 쓰기는 기존 index publication에서 선택적 힌트를 유지하고,
full refresh와 index 증가에는 자체 검증·직렬화 비용이 남습니다.
전체 원본 본문 대신 제한된 선택/관련 본문과 작은 proof metadata를
유지합니다. 이미 들어가지 않는 본문은 참조 검사를 생략할 수 있습니다.
일반 참조 하나는 최대16MiB를 임시로 읽을 수 있습니다.
incoming 개수·상태 집합은 요청 내 집계를 재사용하며 qualifier 실패 때 전체 역사를
다시 걷지 않습니다. 제한된 qualifier 목록 구성과 기록 배열 직렬화에는 표시 데이터에
비례한 비용이 계속 듭니다. 한 조회 요청에서는 기존 read context가 관측한 참조 raw bytes나
읽기 실패를 재사용하되 descriptor마다 digest·kind·owner를 각각 검사합니다.
128MiB retention은 거부 gate가 아니며 그 밖의 정상 참조는 기존 bounded read로
되돌아갑니다. 판정 결과나 parse한 JSON cache는 추가하지 않습니다. 선택 원본의 fresh
재읽기와 마지막 owner/direction basis 검사는 별도 관측이며 나중에 발견한 실패가
앞선 성공보다 우선합니다. 새 요청은 파일을 다시 관측합니다. unknown 검사·fresh 본문
시도(준비했으나 미반환한 본문 포함)·직접 endpoint·incoming producer 역할은 같은 원본에
겹칠 수 있어 단순 합이나 모든 파일 I/O의 상한이 아닙니다. generic reference
enrichment가 work-original 경로를 다시 읽을 수도 있습니다. fitting fallback은 N에
가까워질 수 있으며 관련 본문 확대 상한은 이런 proof·참조 읽기의 상한이 아닙니다.
정상 hinted 조회는 lineage 감사만을 위해 미관측 predecessor 전체를 따라가지 않습니다.
기존 cycle 방어는 실제 관측 metadata에 적용하고 no/legacy index fallback의 전체 발견
집합 방어도 유지합니다. 열거 뒤 추가된 원본은 빠질 수
있는 순차 관찰이지 반환 순간의 원자적 최신 보장은 아닙니다. 필수 index·잠금·쓰기·
서비스는 추가하지 않습니다.

전체 기록만 있으면 `max_characters`는 참조 상태를 추가한 뒤 실제
`JSON.stringify(records).length` 계약을 유지합니다. 부분 필드가 전달되면
`JSON.stringify({records,recordExcerpts}).length`에 발췌의 selector·필드/group coverage와
확장 metadata까지 포함합니다. 바깥 context 봉투와 독립 Todo 투영은 별도 범위입니다.
기본값은 UTF-16 code unit 32,768개이며 UTF-8 bytes·토큰·의미적 충분성이 아닙니다.
최소 예산 2에서도 오류나 숨겨진 초과 없이 본문을 0개 전달하고 제한된 바깥 coverage로
생략을 알립니다.

`recordExcerpts`는 P4 뷰이며 줄인 `records[].content`가 아닙니다. 각 `source`는 정확한
Project/Session/evidence ID/digest를 보존합니다. `fields[].path`는 원래 필드와 배열
인덱스를 유지하며, 부분 문자열의 `range.unit`은 `utf16-code-units`이고 정확한
start/end/total 및 grapheme 경계를 제공합니다. 판단·task 발췌는 group 필드와 원래
관계를 보존합니다. `emptyValues`는 실제 존재하는 empty/null을 지우지 않고 묶습니다.
긴 prefix보다 작은 온전한 구조 단위를 먼저 시도하고 출력 순서는 원문대로 유지합니다.
이는 모델의 중요도나 승인 판정이 아닙니다. coverage는 빠질 수 있는 필드·항목·조건을
알리고 기존 정확한 원문 확장은 제한된 인자를 유지합니다. exact-ID와 명시적 페이지
조회는 전체 원문의 의미와 기존 오류를 그대로 유지합니다.

기본 unavailable 상세는 최대32개 샘플입니다. `coverage.unavailable`은 검사 집합 안의
불가용 원본 수이며 `omissions.unavailableDetailCount`는 그 수에서 표시한 상세 수를
뺀 값입니다. `coverage.valid`에는 body admission을 시도하지 않은 정상 inspected 원본,
관계/qualifier proof-only 원본과 반환 본문도 들어가며 이후 관측한 실패는 제외합니다.
`omissions.byBudget`은 실제 전체 body admission을 시도했지만 기록 수나
enriched 문자 예산으로 탈락한 canonical-valid 원본만 셉니다. 모든 미표시 원본이나
proof-only 원본을 세지 않습니다. 따라서
`coverage.inspected = coverage.valid + coverage.unavailable`,
`coverage.included <= coverage.valid`는 유지하지만 기본 조회에서
`coverage.valid = coverage.included + omissions.byBudget`는 보장하지 않습니다.
재조회해도 동일 원본의 inspected를 두 번 세지 않습니다.
`coverage.included`는 전체 기록, `coverage.excerpted`는 별도의 부분 원본 수입니다.
부분 원본은 전체 본문을 전달하지 않아 `omissions.byBudget`에도 포함될 수 있으므로
서로 다른 원본으로 더하지 않습니다. 재조회 중 변경·소실된 원본은 이전 순서와
새 본문을 섞지 않고 unavailable로 분리합니다. 명시 페이지·정확 ID는 기존 제한된
상세 범위를 유지합니다. 본문 생략과 진단 샘플 생략은 별개이며 빈 샘플이 부재 증거는
아닙니다.

참조는 정확한 경로·바이트 digest·소스/아티팩트 구분을 보존합니다. 바이트 일치는
의미적 최신성이 아니며 다른 Session의 아티팩트는 근거일 뿐 목적이나 승인을
가져오지 않습니다. 변경·누락을 표시하고 경로·digest만으로 내용을 복구했다고 하지
않습니다. 손상된 원본 하나는 해당 항목만 제외하며 유효한 근거·P2 복구·독립 작업을
막지 않습니다. 진입 중 P2나 공통 방향의 변경을 감지하면 섞인 맥락을 폐기하고
Lode가 의존하는 조회만 다시 하도록 합니다. 순차 읽기는 원자적 snapshot이 아니므로
모든 ABA 변경을 감지할 수는 없습니다.

## 식별자 추정 없는 Host 지원

`createSessionHostAdapter`는 신뢰된 embedding Host API입니다. Host가 실제 native
caller와 child의 검증된 별도 agent identity를 얻습니다. 명시적인 `select`는 정확한
논리 Session과 compare-and-swap revision을 검증한 뒤 Project Canon 밖에 P5 연결만
등록합니다. 중단된 pending 선택은 이전/default route가 아니라 미해결 상태로 남습니다.
재시작 후 public adapter가 연결을 읽고 `resolveSessionContext`가 기존 요청별 MCP
resolver에 전달합니다. native ID는 조회용 hash가 되며 canonical Session identity가
되지 않습니다. 읽기 호출에는 claim·receipt가 없습니다. 명시 공유·default 선택은
선택이지 최신 시각·이름·유일 후보 추정이 아닙니다.

선택 저장 실패는 현재 명시 요청의 성공을 취소하지 않습니다. 정확한 논리 route로
그 결과를 계속 쓰되 후속 연결은 미확인으로 표시합니다. 연결만 복구합니다.
어떤 intent도 저장되기 전에 저장소가 실패했다면 재시작으로 유실된 시도 자체를
발견할 수 없으므로, 기록되지 않은 상태에서 무손실 연속성을 주장하면 안 됩니다.

동봉된 `scripts/session-host-hook.mjs`는 선택적 lifecycle 관측과 시작 맥락 투영을
분리합니다. 명령은 Host 로컬 P5 `native-observations` 영역에 제한된 native 이벤트
근거를 보관할 수 있지만 Project·기존 선택 binding·복구 방향은 변경하지 않습니다.
순수 reader인 `sessionStartContext`는 이미 등록된 연결을 조회하고 MCP 준비 전에도
제한된 읽기 전용 맥락을 반환하며, 메모 저장이나 방향 추론을 하지 않습니다.
transcript 본문은 해석하지 않으며 별도의 선택적 계보 관측기만 정확히 지정된
Codex session metadata header를 읽을 수 있습니다. 시작 방향이 크면 조용히 잘라
쓰지 않고 원본을 펼쳐 읽어야 한다고 표시합니다.

시작 맥락은 checkpoint가 없어도 선택된 Session의 현재 `sessionPurpose`를
전달하며, 과거 checkpoint의 목적·결정과 구분합니다. 이미 명시된 현재 공통 방향의
가용성 진단도 보존하므로 확인 불가 상태를 미기록 null과 혼동하지 않습니다.
coverage·생략·확대 안내까지 포함한 최종 JSON에는 공통 7,000자 재절단 대신 Host별
전달 예산 하나를 적용합니다. Claude는 [문서상 문자열 전달 상한](https://code.claude.com/docs/en/hooks#add-context-for-claude)을
보수적으로 적용해 UTF-16 code unit 10,000개 이내로 전달합니다. Codex는 **전체 출력**에
32,768개 로컬 상한을 적용합니다. 기존 기본 work-reader 크기를 재사용한 유한 자원
정책이지 최적값·Host 토큰/컨텍스트 한계·P2 입력 상한이라는 뜻은 아닙니다.
동봉 Codex handler의 숫자형 `additionalContextLimit: 0`은 이 엄격한 전체 출력 상한과
함께 [문서상 전체 출력 옵션](https://learn.chatgpt.com/docs/hooks#large-hook-output)을 사용합니다.
기존 약 4,096토큰 설정은 문자 상한 내 다국어 결과도 파일로 넘길 수 있었습니다.
설치된 Host 지원과 실제 모델 수신은 별도 검증 사항이며 문자·UTF-8 bytes·모델 토큰은
같지 않습니다. 현재 방향·목적·checkpoint 입력에는 텍스트 길이 상한이 없고, 기존
32,768자 work-read 예산은 전체/부분 P3 전달만 제한합니다. 정확한 현재
공통 방향·Session 목적과 최신 선택 checkpoint의 purpose/decisions/position/next-result는
선택적 장문·상세 coverage·ID 샘플·P3 이력보다 먼저 보존합니다. checkpoint의 기록된
승인·다음 단계가 현재 효과 권한이 되지는 않습니다. 현재 내용 자체가 최소의 정직한
표현에도 들어가지 않을 때만 필드 전체를 생략하고 같은 정확한 Session route로
필요한 원본을 펼칩니다. 정상 시작에 추가 조회를 요구하지 않습니다. 선택적 내용을
줄여도 매우 긴 경로가 들어가지 않는
마지막 경우에만 렌더링한 경로를 생략하고 원래 Hook cwd를 출처로 표시합니다.
선택 변경·binding 쓰기·필수 checkpoint·저장·승인·추가 사용자 절차는 없습니다.

정돈된 역사에서는 안내와 첫 기록을 함께, 본문과 savedActivity overlay도 함께
예산 검사합니다. 선택적 organization 상세를 빼더라도 과거 running을 현재 live처럼
보여주지 않습니다. 발견 원본 중 미검사가 남으면 기존 `scope`는 archive hint가
과거이며 inspected 원본만 검사했다는 점도 밝힙니다. 선택적 상세 coverage가 현재
목적·P2에 양보해도 이 범위를 유지합니다. 전체 coverage나 압축 source 수치는 실제
inspected/included 기준이며 짧은 안내가 fresh archive scan을 주장하거나 확대를
의무화하지 않습니다. 기존 restore가 `currentExecution`을 제공할 때만 작은 별도 축으로
정확한 status와 canonical active·pending-review·required-plan 사실을 보존합니다.
incomplete/conflict는 그대로이며 raw pointer가 검증된 실행을 뜻하지 않습니다.
checkpoint가 없다고 새 실행 scan을 만들지 않습니다. 이 축과 과거 기록은 기존
Host별 전체 출력 상한 안에서 현재 공통/P2 방향·목적보다 우선하지 않습니다.
선택적 실행 상세가 들어가지 않아도 최소 canonical 실행 status는 보존합니다.

전달용 중복 wrapper만 줄이며 작성된 의미는 요약하지 않습니다. 각 본문을
배치하기 전부터 짧고 정직한 안내를 사용하고, 긴 선택적 안내는 원문 배치 후
남는 공간에서만 복원합니다. 공통 방향의
`directionId`·`directionHash`·정확한 `input`, checkpoint digest·open review ID와
네 원래 방향 필드를 보존합니다. 이유·대안·참조·남은 작업·unknown을 포함한 work
`content`는 evidence ID/digest·관측 overlay와 함께 그대로 전달합니다.
`referenceChecks[].referenceIndex`는 content 참조의 path/digest/kind가 정확히 일치할
때만 연결하며, 검증 status·실제/null 소유자·비일반 진단을 유지합니다. 연결되지 않는
descriptor는 전체를 보존하고 추측하지 않습니다. 해시는 압축 JSON이 아닌 검증된
원본의 selector입니다. bytes 일치는 의미적 현재성이나 권한을 증명하지 않습니다.
불가용·basis 변경은 기록이 0개여도 status·reason·확장 경로를 보존합니다.
같은 순수 P4 fitter가 발췌 metadata를 포함한 startup 전체 JSON을 기존 Host별
상한에서 측정합니다. 전체 work content는 바꾸지 않고 startup 공간이 더 작으면
명확히 구분한 부분 발췌를 전달할 수 있습니다. 전체 기록 0개와 발췌가 함께 있으면
빈 이력도 완전 복구도 아닙니다. 원본·선택·binding·필수 도구 체인·사용자 절차는
추가하지 않습니다. 보호된 P2 자체가 들어가지 않을 때만 필드 전체를 생략하고
관련 작업용 확장을 표시합니다.
생략된 취소를 취소 없음으로 해석하지 않습니다. 로컬 spill 파일이나 자동 추가 조회는
생성하지 않으며 실제 Host의 spill/미리보기를 완전 복구라고 부르지 않습니다.
출력 상한은 이미 유효한 무제한 길이 P2 입력을 읽는 메모리까지 제한하지는 않습니다.

| 경로 | 구현된 지원 | 중요한 한계 |
| --- | --- | --- |
| Core CLI/MCP | 정확한 논리 Session 기록 → 같은 Session 진입, 선택적 typed 확대 | native caller identity를 추론하지 않음 |
| 신뢰된 embedding Host | public 선택·등록 → 재시작 조회 → 요청별 resolver → 같은 Session | 실제 요청별 caller를 구분해 얻는 것은 Host의 책임 |
| Codex native MCP transport | 실제 요청의 `params._meta.threadId` → 기존 초기화·재개 선택 → P5 연결 → 요청별 resolver; 순수 SessionStart 조회는 읽기 전용이고 별도 Hook 관측은 P5 | 설치 엔진 `0.162.0-alpha.17.2` transport 확인; GUI 모델·fork/child·실제 재시작/압축은 별도 검증 필요 |
| stock Claude Code | 같은 서버의 PreToolUse 연결 → 기존 초기화·재개 선택 → P5 연결 → 후속 direct/router 요청 해석; 순수 SessionStart·재개 투영은 읽기 전용이고 별도 Hook 관측은 P5 | 설치 CLI `2.1.289`와 합성 로컬 프로토콜로 부모·자식 분리 및 새 프로세스 재개 확인; 실제 모델·계정·압축은 별도 검증 |
| OpenCode | Core와 신뢰된 Host 연결 지점 | native Hook 통합은 주장하지 않음 |

Codex tool Hook는 child에도 부모 session ID를 제공하므로 그 필드만으로 caller 선택을
안전하게 등록할 수 없습니다. Codex 인자 수정에는 allow 결정도 필요해 routing에
사용하지 않습니다. 일괄 Hook 거절, 정상 경로의 거절·재시도, 승인 우회나 전역 MCP
selector를 넣지 않습니다. 선택적 연결 유실 후에도 정확한 명시 요청과 독립 Project
작업은 가능합니다.

공유 상태 쓰기 정책은 라우터 내부 도구를 확인한 뒤 종속 Session 안내보다 먼저
한 번 적용합니다. 기본 보호는 정확한 근거가 있는 지원 Claude·OpenCode 자식 호출만
대상입니다. Codex는 기본 off를 유지하며, 명시적
`LODE_SUBAGENT_WRITE_GUARD=enforce`는 기존의 확인된 자식 동작을 유지합니다.
명시적 off는 이 선택적 Host 보호를 끕니다. 보호할 상태 쓰기는 카탈로그의
`readOnlyHint` metadata로 판단합니다. 읽기·부모/독립 작업·일반 소스 편집은
계속 가능합니다. 거절 오류 `SUBAGENT_STATE_WRITE_REJECTED`는 새 사용자 승인
절차나 부모의 권한을 만들지 않습니다.

Claude의 소유 local/plugin PreToolUse matcher는 실제 카탈로그로 Session/전환·
라우터·effectful 범위를 만들고, 유한한 지원 별칭을 포함하되 helper/다른 서버는
제외합니다. 자식 `agent_id`는 정확한 외부 도구명·인자 digest·`tool_use_id`와
실제 MCP `claudecode/toolUseId`에 결합합니다. Project만 사용하는 보호 쓰기도
같은 제한된 일시 registry를 사용하며 Session/P2/inventory를 읽거나 저장하지
않습니다. `caller.subagent` 비트만 있거나 signal-only fallback, 만료·재사용·불일치
claim, native metadata 부재만으로 기본 보호를 켜지 않습니다. 이 경로는 지원
미확인이지 보호 성공이나 일괄 거절이 아닙니다.

명시적으로 강제할 때 Codex는 기존 `_meta.agent_id` 또는 `_meta.subagent`, native
ID가 `params._meta.threadId`와 같은 `SubagentStart` 관측을 계속 사용합니다.
설정 없음/off는 이 추가 조회 비용을 만들지 않습니다. OpenCode는 실제로 대기하는
before-hook에서 소유 서버·정확한 call ID·Project/directory·Session `parentID`로
같은 정책을 적용합니다. 호출 간 자식 티켓을 게시하지 않습니다. 일반 소스 도구와
읽기는 정책을 위한 Session 조회가 필요 없습니다. call ID 부재·지원하지 않는 범위·
조회 오류·timeout은 보호 성공을 주장하거나 독립 작업을 막지 않습니다. 두 경로 모두
악의적인 클라이언트 격리나 실제 설치 Host 전달의 증거는 아닙니다.

### 어떤 작업이 선택을 유지하나?

기존 `lode_project_initialize_or_resume`의 성공한 선택만 보존합니다. 첫 초기화는
검증된 default를 유지하며 명시 재개로 기존 Session을 공유·분리할 수 있습니다.
동일 선택 반복에는 쓰기가 없습니다. 별도 select/bind 도구, 사용자 ID 입력,
save 절차나 승인 결정을 추가하지 않습니다. Session 생성만 하거나 일회성으로
읽기·다른 Session에 증거/checkpoint 기록·worker 통합을 해도 채팅 선택은 바뀌지 않습니다.

기존 bootstrap 입력·identity 검증 뒤 선택적 P5 준비를 합니다. 실행 요청은 자신의
pending 상태에도 이미 검증한 route를 유지합니다. 짧은 CAS 구간이 전체 실행을
잠그지 않으며 앞선 완료가 새 intent를 덮어쓰지 않습니다. 검증된 pre-effect 실패만
이전 선택으로 정산할 수 있고 일반 오류·취소·timeout으로 효과 부재를 추정하지 않습니다.
unknown이나 재시작 후 live ticket 부재에서는 pending 불확실성이 남습니다. Host 저장
실패는 원래 Core 결과를 바꾸거나 효과를 재실행하지 않습니다. caller와 연결은 P5이지
P2 방향이 아닙니다.

같은 MCP process의 여러 caller도 각각 outer transport metadata로 라우팅합니다.
last-caller selector나 도구 인자의 `_meta`는 쓰지 않으며 embedding Host resolver가
우선합니다. 처음 연결하는 caller는 기존 default 의미를 유지하되 읽기에서 저장하지
않습니다. known lost/pending/corrupt 및 기존 namespace의 binding 유실은 default로
바꾸지 않습니다. namespace까지 완전히 삭제되면 그 과거 이력을 증명할 수 없습니다.
native metadata가 없는 legacy 경로는 자동 지속성을 주장하지 않습니다. native 전달을
관측한 뒤 그 값이 유실되면 관련 dependent 호출만 미확인이며 valid explicit 요청과
독립 Project 작업은 계속 가능합니다.

### 추가 승인 게이트 없는 Claude 요청 연결

동봉된 PreToolUse Hook는 이 플러그인의 Session 의존 도구와 범용 router만 대상으로
local 또는 plugin-scoped의 정확히 같은 MCP 서버를 호출합니다. 실제 `session_id`,
자식의 별도 `agent_id`, `tool_use_id`, outer 도구명과 원래 outer 인자를 전달합니다.
실제 일반 MCP 요청의 outer `claudecode/toolUseId`로 메모리 registry를 조회하고
인자의 정확한 digest를 검증한 뒤 router를 펼쳐 해당 caller만 해석합니다.
관측된 stock transport에서 모델 직접 호출·helper router 호출·중첩된 가짜 metadata·
치환되지 않은 template은 연결을 만들 수 없습니다. 이는 확인된 stock transport
연결 지점이지 임의 client를 인증하는 보안 수단은 아닙니다.

helper는 `{}`만 반환하며 `permissionDecision`, `updatedInput`, 논리 Session,
승인 또는 P2 방향을 전달하지 않습니다. 도구 권한은 기존 Host가 관리합니다.
독립 direct 도구의 추가 RPC는 0회입니다. 범용 router는 독립 inner 작업에도 내부
Hook RPC 1회를 추가하지만 곧바로 no-op입니다(registry·Session/P5 읽기·graph scan·
원본 쓰기 없음). 사용자 질문·binding 양식·Run·Capsule·저장 receipt·daemon은 없습니다.

대기 연결은 10분 후 만료되고 최대 1,024개이며 실행 중인 연결은 밀어내지 않습니다.
정확한 대기 재시도는 수명을 연장하지 않고 수렴하며 충돌·실행 중 재사용은 다른
caller를 대체하지 못합니다. claim은 `finally`에서 해제하고 transport 종료 시 cache를
비웁니다. 거절된 호출은 sweep·종료까지 메모리에 남을 수 있지만 호출별 영구 artifact는
아닙니다. bounded spent cache는 영구 replay 방지나 실행 lease가 아닙니다.
처음 온 Claude 요청도 일치하는 Hook가 없으면 의존 자동 route만 미확인으로 두고
default를 추정하지 않습니다. 정확한 명시 route와 독립 작업은 계속 가능합니다.
새 Project 초기화는 native 연결 성공을 주장하지 않고도 가능합니다. Hook 미활성화·
만료·선택적 저장 실패는 진단 공백이지 완료된 효과를 다시 실행할 이유가 아닙니다.
재개에는 같은 native chat·Project·operational binding 저장소가 필요하며 다른 PC로의
지속 연결을 의미하지 않습니다.

공식 계약: [Codex Hooks](https://learn.chatgpt.com/docs/hooks)와
[Claude Code Hooks](https://code.claude.com/docs/en/hooks).
소스·command fixture는 로컬 계약을 입증할 뿐 설치 Hook 신뢰·실제 provider 호출·모델
이해를 입증하지 않습니다. 패키지 설치만으로 Hook 실행이 증명되지는 않으며 실제
활성화와 계정·모델 시험은 별도입니다.

## 경로 기준과 기존 Project

Project 내부 참조는 검증된 Project root를 기준으로 한 `/` 상대경로입니다. 생성
Markdown의 `relativePath`는 게시 root 기준이고, href는 해당 문서 위치 기준입니다.
문서의 `../` 링크가 원본 selector의 `..`를 허용하는 것은 아닙니다.

런타임 `project_root`, 저장된 `projectRoot`, 설치의 `pluginRoot`와 root 기반 식별자는
검증된 절대 root와 실제 Session 소유자에 계속 결합됩니다. 새 Project는 `.lode/`를
사용하고 기존 `.head/` 원문과 exact selector는 그대로 유지합니다. 이는 기존 경로
계약의 설명이며, workspace 이동 지원이나 자동 repair 기능이 아닙니다.


읽기 전용 `sessionStartContext`는 선택된 Host 어댑터와 로컬 snapshot 읽기가 끝난 뒤 표시 내용을 만듭니다. Codex·Claude command Hook과 OpenCode context callback은 완료된 값을 사용하며, 아직 끝나지 않은 Promise를 빈 context로 표시하지 않습니다. Session 선택과 P2 권한은 바꾸지 않습니다.

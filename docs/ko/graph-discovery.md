# 그래프 우선 탐색과 독립 Session

> 영어 원문: [graph-discovery.md](../graph-discovery.md)

## 일반 사용

사용자는 task를 한 번 말합니다. Lode는 해당 논리 Session과 현재 공통 방향을
복구하고 새 정보 탐색 전에 가까운 프로젝트 관계를 조회합니다. 충분한 동일
기준 결과는 재사용합니다. 없거나 실패한 그래프 층은 원본 파일과 기록으로
보완합니다. 전체 World 갱신, Product 승인, Run/Capsule, 색인 완료나 DB는 일반
탐색의 시작 조건이 아닙니다.

작업 관점은 Session, 변경, 결과, 검토와 복구 기록을 연결합니다. Product 관점은
제품 목표, 요구사항, 결정과 원본 근거를 연결합니다. 같은 결정을 이중 저장하지
않고 공통 원본을 참조합니다. 현재·과거 리비전과 미승인·거절 자료의 ID와 상태는
관계 확장에도 유지됩니다. 경로는 출처·선후를 설명하며 그 자체로 원인을 증명하지
않습니다.

## 조회와 원본 보완

기본 typed MCP 진입점은 `lode_project_graph`입니다. Lode가 task에서
`project_root`, `query`를 작성하며 필요할 때 `anchor_ids`, `paths`, `depth`,
`max_nodes`, `max_edges`, `view` (`all`, `work`, `product`),
`world_model_id`, `previous_result`, `include_candidates`, `session_id`를
지정합니다. 한도는 전송 크기를 제한하며 의미적 충분성 판정이나 사용자 양식이
아닙니다.
양 끝을 포함하는 정수 범위는 depth 0–8, node 1–500, edge 0–1000입니다.
edge 0은 Core·CLI·MCP에서 node만 조회하는 지원 값이며 node 0을 뜻하지 않습니다.
범위 밖 값과 정수가 아닌 typed 입력은 변환해서 받아들이지 않고 거부합니다.

기본 compact 결과는 node 8개·edge 12개를 선택하고 identity, revision/state,
provenance와 coverage를 보존하면서 반복되는 큰 payload를 생략합니다.
원본 상세와 관계가 필요하면 반환된 anchor에 `details: true`를 지정합니다.
상세 기본값은 node 60개·edge 120개이며 명시적 한도로 양쪽 뷰를 확대할 수 있습니다.
짧은 응답은 task의 충분성을 증명하지 않습니다.

### 저장된 작업 이유와 남은 일

이미 보존한 `SessionWorkEvidence`는 기존 `lode_project_graph`와
`graph-query` 경로로 찾습니다. 요약에 없는 용어라도 실제 판단의 assessment,
이유·대안, 관측한 작업, 남은 일과 불확실성에서 검색할 수 있습니다. 정확한 경로,
anchor, Session 또는 근거의 이웃 조회도 같은 typed 작업 노드와 실제 소유자를
반환합니다. 기존 원본을 찾기 위해 새 저장, native 연결, Run, 색인 갱신이나
사용자 작성 selector를 요구하지 않습니다.

지정한 `paths`가 모두 지원되는 정식 Session 작업 원문·실행 계보 아티팩트·과거
ProjectDirection 리비전 경로이면 전역 inventory나 캐시의 membership 열거보다 먼저
해당 원본과 필요한 의존성을 읽습니다. 소유자·경로·
bytes와 typed 원본 검증은 유지하고 상세 확장에도 정확한 경로를 보존합니다.
`coverage.inventoryScope`가 이 좁은 관측 범위를 나타냅니다. 무관한 원본 목록과
범위 밖 incoming 관계는 부재가 아니라 unknown입니다. 유용한 결과는 재사용하며,
이 부분 범위 자체가 추가 조회를 요구하지 않습니다. 소스 코드 경로나 혼합 경로
질의의 기존 의미는 유지합니다. 전체 층의 검토 의존성이 필요한 다른 유형은
개별 JSON만으로 검증을 우회하지 않습니다.
`world_model_id`를 명시한 경우도 기존 통합 질의를 유지하며, 좁은 원문 조회가
요청한 과거 World를 대신하지 않습니다.
명시한 anchor도 모두 요청한 정확 원본의 ID여야 좁은 경로를 사용합니다. 별도 plan이나
작업 anchor가 있으면 기존 anchor 우선 통합 조회를 유지하며, 경로 최적화 때문에
명시한 anchor를 누락하지 않습니다.

실행 계보 경로는 기존 exact 아티팩트 reader를 재사용하며, 선택 Session·관리 manifest·
관리 파일 digest 검사도 유지합니다. 디스크 파일 하나만 읽는 비용 보장은 아닙니다.
반환한 `originalExpansion`은 해당 아티팩트의 기존 lineage reader를 호출합니다.
보존된 plan·contract·result·review는 현재 실행 허가나 선언한 부모의 존재 증명이
아닙니다. 과거 direction 경로는 현재 포인터나 전체 방향 trace를 훑지 않고 리비전
reader를 사용하며 현재성은 unknown입니다. 정확한 graph detail은 같은 리비전 경로를
유지합니다. 공개된 과거 direction 전체 원문 reader가 없다는 한계와 부분 내용 보완용
원본 파일을 표시하며, 현재 direction 도구가 과거 리비전을 선택한다고 안내하지 않습니다.

알려진 Session의 더 넓은 기록이 필요하면 `lode_session_work_read`에
`scan_evidence: true`를 주어 첫 페이지를 받고 `enumeration.next`의 인자를 따릅니다.
CLI에서는 `session-work-read --scan-evidence`를 사용합니다. 가짜 시작 ID나 사용자가
작성한 JSON은 필요하지 않습니다. 한 호출은 사전순 원본 페이지 하나를 검사하며,
전체 시간순 이력이나 원자적 스냅샷을 뜻하지 않습니다. 그래프의 `nextAnchorIds`와도
별개입니다. 일반 Project·layer inventory 이어 읽기는 아직 미구현이며, 다른 질의는
기존의 한정된 부분 결과와 정확한 원문 보완 경로를 유지합니다.

명시적 anchor나 paths가 없는 text 질의에서는 matching 작업 원본을 먼저 담고,
검증된 직접 declared root와 명시적 작업 인용을 다음 matching 기록보다 먼저
담습니다. 공유 endpoint는 node 한 개지만 고유 연결 edge는 각각 한도를 사용합니다.
동반 원본이 못 들어가도 matching 원본은 남으며 기존 node·edge·depth 한도는
늘리지 않습니다. 생략한 matching 수는 실제 반환 집합으로 계산합니다. companion은
깊이1이지 새 깊이0 seed가 아닙니다. 명시적 selector·깊이0·edge0의 의미는 그대로입니다.
이는 기록된 관계의 탐색이지 의미적 충분성·추론된 작업 identity나 새 Feature 색인이
아닙니다.

명시적 `paths` 필터는 `kind: "source"` 참조가 정확한 논리 Project 경로를 선언한
검증된 과거 작업도 찾을 수 있습니다. 대상이 변경·소실·크기 초과·비파일·권한 거절·
기타 확인 불가여도 이름 연관성은 남으며, 관측된 `SESSION_PATH_ESCAPE`는 새 일치에
기여하지 않습니다. artifact-kind 참조만으로는 이 자격이 생기지 않습니다. 원래 출처,
보존·현재 digest와 참조별 진단은 별개로 유지합니다. 이름 연관성이지 현재 대상의
안전·소유권·본문 복원·효과 권한 증명이 아닙니다. 참조 경로를 검색 본문이나
exact-score 가산에 추가하지 않습니다.

반환된 완전한 `workContent`는 재사용합니다. 유용할 때 실제 반환된 root·검증된 typed
endpoint·boundary selector를 `anchor_ids`와 `depth > 0`의 한정된 이웃 조회로 따르며
compact 한도를 유지하고 무관한 검색 필터는 빼둡니다. 깊이0의 `detail`은 그 원본을
펼칠 뿐 sibling을 탐색하지 않습니다. 실제 부분 본문만 지원되는 반환 detail이나
`originalExpansion`으로 확대하며 selector가 있다는 이유로 완전본문을 다시 읽지
않습니다. 한도 때문에 대안이나 후속 변경 본문이 빠질 수 있으므로 미해결 coverage를
남기고 비어 있지 않은 결과를 완료로 간주하지 않습니다. 추가 저장·승인·색인·연결이나
World 도구 체인을 요구하지 않습니다.

노드의 `workContent`는 생성한 설명이 아닌 원문 값입니다.
`workContentCoverage.partial`로 완전한 본문과 표시 생략을 구별합니다.
작고 fitting인 이유는 short에서도 완전하게 보이며, 작은 이유 여러 개의 합이
일반 작업 reader의 기본32768자를 넘는 경우도 포함합니다. 선택된 작업 원본이
한 건이고 기존 최대 안에 들면 Session·파일 탐색 노드가 함께 있어도 약64KiB에
가까운 본문을 보존합니다. 짧은 질문 결과라는 이유로 상세 조회를 추가하지 않습니다.

기본 CLI/MCP text는 실제 소유자와 과거/부분 범위를 짧게 알린 뒤, 반환된 원문
본문과 묶인 판단을 상세 metadata보다 먼저 보여줍니다. 한 판단의 assessment·이유·
대안은 함께 두며 원래 값과 순서를 유지합니다. 미지 key와 빈 값을 포함한 추가
원문 필드는 원래 객체 위치에 남기고, identity·참조 진단과 나머지 상세는 해당
node나 edge 뒤에 둡니다. coverage·발췌 구간·생략·지원되는 확대 안내는 이를 담은
결과에 함께 유지합니다. 이 표시는 요약·필드 상한·조회를 추가하지 않으며 Core 값,
MCP `structuredContent`, CLI `--json`, Hook, 선택과 proof는 그대로입니다.

기본 text는 작업 projection의 정확히 알려진 false 권한 flag를 역사적 범위 안내에
흡수하고 `coverage.state`를 두 번 찍지 않습니다. `selectedBodyGroups`는 원래 index와
소유자까지 실제 표시한 그룹과 완전히 같고 생략이 없을 때만 중복 표시를 뺍니다.
부분·미지 metadata, 새로운 값, 실제 본문·진단·확대는 남깁니다. 이 text 전용 정리는
`details: true` 그래프 text에는 적용하지 않으며 두 모드의 structured 값과 JSON은
그대로입니다. text 감소가 reader I/O·heap·모델 token 감소를 뜻하지는 않습니다.

큰 다중 원본 결과의 `workContentExcerpts`는 실제 원문의 field/index/subfield
범위와 전체 길이를 표시합니다. 축약한 이유를 완전한 원문 값인 것처럼 넣지
않습니다. 한 노드의 긴 이유가 다른 노드의 몫을 모두 차지하지 않도록 원래 남은
일과 불확실성도 노드들에 걸쳐 표시합니다. `details`는 기존의 더 풍부한 표시를
요청하며 어느 표시도 의미적 충분성을 판정하지 않습니다.

`originalExpansion`은 기존 `lode_session_work_read` 호출에 검증된 소유자의
`session_id`, 정확한 `evidence_ids`, 한 건을 뜻하는 `max_records`, 실제 enriched
record 배열 크기의 `max_characters`를 제공합니다. 같은 기준의 확장이 성공하면
예산 생략 없이 그 원본 한 건을 반환합니다. 소유자·ID·`evidenceDigest`를 그래프
결과와 비교합니다. 이 digest는 원본 파일 bytes를 식별하는 `sourceReference.digest`와
다릅니다. 탐색 뒤 원본·소유자·참조가 바뀌면 해당 원본만 재확인하며 과거 크기
추정으로 현재 완전성을 증명하지 않습니다. enriched 한 건이 reader의 기존 최대를
넘으면 거짓 완전 확장 호출을 만들지 않고 원본 소스 fallback을 유지합니다.

저장된 running·paused·ended·unknown 관측은 과거 근거입니다. 남은 일, 미확인 효과,
canonical 검토 의무나 현재 취소를 지우지 않습니다. 파일 인용은 보존한 리비전과
현재 bytes 상태를 유지하며, 참조가 바뀌거나 확인 불가여도 온전한 작업 원본을
지우거나 과거 파일 본문이 복원됐다고 주장하지 않습니다.

완전본문과 변경된 참조 또는 `sourceFallback`이 함께 있다는 이유만으로 그 본문을
다시 읽을 필요는 없습니다. 다음 판단에 실제로 필요할 때 빠진 내용을 확대하거나
영향받는 현재 소스를 확인합니다. fallback도 읽기 쉬워진 과거 본문도 현재 효과
권한을 부여하지 않습니다.

조회는 읽기 전용이며 Project 범위입니다. 정확한 재조회 proof도 허용된 모든 작업
producer bytes와 소유자·관계 의존을 확인하므로 상수 시간·상수 bytes 조회가
아닙니다. cold 탐색, 참조 확인, 출력 shell, text/structured 내용의 중복 비용은
남습니다. 한정된 표시 본문과 기존 cache 퇴출만으로 작은 메모리 사용, Host 전달,
모델 준수나 성능 향상을 증명하지 않습니다.

자연어 질문은 권한 플래그나 리비전·출처 메타데이터가 아닌, 한정된 표시·도메인
값을 검색합니다. 일치하는 드문 용어를 우선 정렬하고 전송 한도를 적용합니다.
이는 재현 가능한 어휘 탐색이지 의미 추론이 아닙니다. 관련성과 부족한 맥락은
Lode가 판단합니다. 구두점, 식별자 구성 단어, 한국어 조사 별칭으로 탐색을 돕되
원래 용어도 보존합니다. 필요한 정확한 경로·anchor는 Lode가 작성하며 사용자가
질문이나 점수 양식을 다시 작성하지 않습니다.

```text
lode-agent graph-query <project> --query "<task>"
lode-agent graph-index <project>
lode-agent session-list <project>
lode-agent session-create <project> --purpose "<independent work>"
lode-agent graph-query <project> --session <logical-session> --query "<task>"
```

`lode_project_graph_index` / `graph-index`는 교체 가능한 기존 관측 색인을
명시적으로 갱신합니다. Core 초기화·재개와 원본·관측 저장 경로도 필요한 범위에서
갱신합니다. 입력이 같으면 재사용하며 조회마다 receipt, 후보, 승인이나 checkpoint를
만들지 않습니다.

결과의 기준·리비전, 무결성, 최신성, 확인 범위, 원래 상태와 출처를 함께 읽습니다.
온전한 과거 자료는 현재 효과를 승인할 수 없어도 근거로 활용할 수 있습니다.
손상·교차 Project 층만 제외하고 나머지 유효한 층은 계속 사용합니다. 빈 결과나
부분 결과는 사실 부재의 증명이 아닙니다. 반환된 원본 fallback을 사용하고 부족한
맥락만 확대합니다. 충분한 이전 결과나 동일 기준의 알려진 adapter 실패는 재호출
없이 재사용하고 관련 기준이 달라지면 다시 조회합니다. 현재 효과 검사는 별개입니다.

### 범위를 명시한 반복 조회

텍스트·경로 검색이 없고 World·사용자 store·adapter가 없는 정확한 로컬 anchor는
프로세스 내 이전 탐색을 재사용할 수 있습니다. Project·색인 bytes, 디렉터리 이름·타입,
선택 원본, 관계 생성 원본과 잘린 이웃 endpoint, 선택 소스 bytes와 숨은
review·lineage·Session·Run 근거를 검사합니다. 기존 경로가 생략하던 무관한 Session
현재 상태 본문을 새로 전수 검사하지 않습니다. depth0의 work 전용 anchor가 모두 실제 반환
node 집합에 들어가면 무관한 reference-only bytes와 유일하게 대응한 과거 canonical-valid
독립 work 원본은 proof에서 빠질 수 있습니다. 선택 work의 참조, 실제·잠재 incoming
producer와 직접 필요한 endpoint/root gate, 기존 non-work/owner/default 의존과 불확실한
work는 보호합니다. 현재 edge가 없다고 potential producer가 무관한 것은 아닙니다.
identity/origin이 모호하거나 maxNodes 때문에 matched anchor가 빠지거나 미지원 query이면
기존 보수적 proof 또는 원본 fallback을 유지합니다. 같은 path에 필요한 역할이나 불확실한
역할이 하나라도 있으면 생략하지 않습니다.

반환된 node의 `detail`을 기존 `lode_project_graph`의 `anchor_ids`, `details`, `depth`로
따라가며 추가 selector나 native binding은 필요하지 않습니다. 정규화 기본값은 상세의
maxEdges120, compact의 maxEdges12 그대로입니다. 명시 maxEdges0은 별도 query key이지
재사용 조건이 아닙니다. depth0도 incident boundary/다음 anchor를 공개합니다. 색인 부재·
stale·membership/layout 변경·필요 proof 실패는 새 gate·복구 쓰기·필수 추가 조회 없이
기존 원본 탐색으로 돌아갑니다.

더 좁은 결과는 별도 ID와 `scoped-originals-reused` 상태를 갖습니다.
`verifiedLayers`는 비어 있고, `retainedVerifiedLayers`는 이전 typed 탐색입니다.
`verifiedRecordPaths`는 실제 byte proof의 경로를 최대256개까지 표시하며
`verifiedRecordCount`, `omittedVerifiedRecordPathCount`, `basis.proofDigest`는 그 proof를
설명하지 inventory 전체 기록을 뜻하지 않습니다. 목록·관계의 basis digest,
`retainedDiscoveryNodeCount`, `coverage.layers`는 이전 탐색 범위입니다.
`integrity.excluded`와 `sourceFallback.excludedInputs`도 보존한 제외 진단이지 지금의 무관한
손상·부재 원본을 새로 전수 검사한 통계가 아닙니다. `sourceFallback.action`이 이 차이를
밝힙니다. 읽지 않은 독립 원본의 이후 timestamp 변경이나 손상만으로 좁은 재사용이
깨지지 않을 수 있으며 그 원본의 현재 무결성을 인증하지 않습니다. Coverage는 무관한
bytes를 재검증하지 않았음을 밝히고 현재 membership은 이름·타입만 뜻합니다.
선택·boundary 밖 소스와 읽지 않은 Session 본문 수정으로 새로 생긴 관계는 미확인입니다.
원본 fallback은 계속 가능합니다. 효과 전에는 관련 현재 원본과 별도
효과 권한 검사를 사용합니다. 새 anchor나 전체 검색으로 외부 변경을 다시 발견할 때
추가 사용자 승인은 필요하지 않습니다.

최초 조회, 어휘·경로 검색, 원본 수집 실패 anchor, 보존 World와 선택적·사용자 adapter 조회는 기존 전체 경로를
유지합니다. Membership·색인 bytes는 기록 수에 따라 증가하고 최초 준비에는 증명·색인·
membership 작업이 추가됩니다. Warm 파일 읽기 감소가 상수 bytes나 지연시간 개선을
뜻하지 않으며 작은 프로젝트는 색인 때문에 더 많은 bytes를 읽을 수 있습니다.
cold typed 탐색·proof 분류·보존 result 복사·warm 출력 clone의 비용과 메모리는 남습니다.
기존 seed/hit 검사 순서는 유지하며 hit의 proof scan 뒤 새 membership/index 후검사는
없습니다. 따라서 순차 관측이지 반환 순간의 원자적 snapshot이 아닙니다. 이 graph 전용
재사용이 기본 복구·startup·SessionStart Hook 조회를 개선하지는 않습니다. 승인·P2 방향·
효과 권한을 만들지 않습니다. 조회는 기록을 쓰거나 watcher를 설치하거나 사용자에게
전체 이력 감사를 요구하지 않습니다.

### 설치 패키지와 활성 연결의 구분

설치 파일 무결성과 현재 대화의 MCP schema·runtime은 별도로 확인합니다.
해당 대화의 기존 읽기 전용 entry·graph 도구를 의도한 root에서 호출하며 임의 Project를
초기화하거나 다른 채팅의 성공을 이 채팅의 reload 증거로 삼지 않습니다. edge 0 거부는
import·설치 실패가 아닙니다. 새 CLI나 따로 실행한 app-server도 데스크톱 대화의
활성 연결을 검증하지 않습니다.

[공식 app-server 문서](https://learn.chatgpt.com/docs/app-server)는
`config/mcpServer/reload`가 디스크 설정을 다시 읽고 로드된 thread의 refresh를
예약한다고 설명합니다. 해당 기능이 실제 노출되고 승인된 Host에서만 지원 reload를
사용한 뒤 대상 대화를 다시 확인합니다. 이 플러그인은 그 데스크톱 Host 기능을 제공하지
않습니다. 사용할 수 없다면 활성 연결 미검증을 밝히며 공유 MCP 프로세스 종료,
캐시 편집이나 자동 복구 완료를 주장하지 않습니다.

선택적 ArcadeDB는 활성 temporal-query 검증과 embedded fallback을 보존합니다.
공통 원본 조회는 Core/로컬에서 수행하며 전체 조회 가속을 주장하지 않습니다.
기존 prepared-traversal 가속은 별도 adapter 계약을 따릅니다. 로컬 색인과 원본
fallback은 계속 사용할 수 있습니다. 이번 소스·fixture 시험으로 새
실제 ArcadeDB, Host lifecycle이나 모델 행동 검증을 주장하지 않습니다. 속도,
token과 품질 개선은 측정 전까지 가설입니다.

경로만 지정한 요청은 검증된 보존 World의 논리 File anchor와 정확한 snapshot에
결속해 선택적 temporal adapter 검증을 수행합니다. 사용할 temporal 선택자가
없는 전체 둘러보기·Work 전용 anchor는 adapter 실패가 아닌 `not-used` 로컬
탐색입니다. 실제 adapter 실패의 사유와 동일 기준 fallback 재사용은 유지하며
어느 경로도 공통 전체 조회 가속을 주장하지 않습니다.

## 코드 영향과 기록 탐색의 구분

일반 `CONTAINS`, `HAS_REVISION`, `DECLARES` 경로는 기록·버전을 연결합니다.
이를 확대하는 것은 코드 영향 분석이 아닙니다. 심볼의 import·call 이웃은 기존
`lode_world_query` 또는 다음 명령으로 조회합니다.

```text
lode-agent world-query <project> --query "<symbol>" --depth 3 --limit 20
```

World 기능이 제공될 때 한정된 `IMPORTS`·`CALLS`를 조회합니다. Lode는 기존
선택적 MCP 검색·호출 경로를 사용하므로 새 사용자 설정은 필요하지 않습니다.
World가 없거나 관련 소스가 stale이면 현재 소스의 import·call을 직접 조사합니다.
보존된 관계는 조사 단서이지 현재 영향의 증명이 아닙니다. 전체 World 갱신,
새 Run, Product 검토나 DB 활성화를 조사 게이트로 만들지 않습니다.

## 통합 변경 뒤의 증거 갱신

의미 있는 코드 수정이나 기능 추가 구간이 끝나면 Lode는 통합 결과의 그래프 갱신
필요를 확인합니다. 수정 파일뿐 아니라 추가·변경·삭제·이름 변경과 관련 참조·import·call도
살핍니다. worker는 변경, 원본 근거와 미확인을 반환하고 Lode가 최종 checkout을
조정한 뒤 갱신과 검증을 책임집니다. worker마다 무조정 전역 갱신을 수행하지 않습니다.

| 기존 surface | 수행하는 일 | 수행하지 않는 일 |
| --- | --- | --- |
| `lode_project_graph_index` / `graph-index` | 기존 검증 기록·관측의 교체 가능한 목록 색인을 갱신하고 동일 입력은 재사용합니다 | 저장소의 새 코드 관계를 추출하거나 기능 의미를 추론하지 않습니다 |
| `world-refresh` | 이미 활성화된 World의 지원 코드 관계와 리비전 근거를 갱신합니다 | 없는 Product/World 기능을 활성화하거나 승인을 만들지 않습니다 |
| `lode_world_model`, `lode_incremental_refresh_status`, `lode_world_query` / `world-query` | 최신성·갱신 근거 또는 제한된 영향 관계를 읽습니다 | World 갱신을 실행하지 않습니다 |

Core 초기화·재개와 지원되는 원본·관측 저장 경로는 이미 관측 색인을 갱신합니다.
충분히 최신인 결과는 재사용합니다. 관련 새 기록·누락 기록이나 통합 조정에 필요하면
명시적 색인을 사용하되 매번 저장 후 수행하는 의식으로 만들지 않습니다. 후속 작업에
기존 World 관계가 필요할 때 현재 갱신은 설정된 소스 범위의 **전체 eligible 파일**을
발견하고 읽어 해시하며, 변경 없는 의미 분석을 재사용한 뒤 현재 파일 집합 기준으로
지원 관계를 재계산합니다. 변경 파일만 읽는 방식이 아닙니다. 수정하지 않은 호출자의
대상도 새로 연결되거나 사라질 수 있습니다. 제외 범위, 분석기 지원·신뢰도, 미해결
import·call과 다른 미확인은 보존합니다. 이름 변경은 삭제·추가로 관측될 수 있으며
이름 일치만으로 의미적 동일성이나 검증된 이름 변경 계보를 만들지 않습니다.

Lode는 기능 목적·요구사항, 구현과 실제 검증을 기존 소스 문서, 사용자 방향, 코드 참조와
해당 관측·결과·후보 기록으로 연결합니다. 원본 경로, digest·revision과 승인 상태를
유지합니다. 테스트 존재는 PASS가 아닙니다. 실행에는 실제 명령, 검증한 기준, 결과와
불확실성이 필요합니다. 일반 문서, 대화나 실행 성공을 색인한다고 Product Canon이나
승인이 자동 생성되지는 않습니다. 기존의 정확한 사용자 검토 절차는 그대로 유지합니다.
현재 사용자 방향은 참조하며 기능 설명을 저장하려고 P2 방향을 기록하지 않습니다.
기존 그래프 스키마는 지원 참조를 투영하며 임의의 문장을 자동으로
기능→코드→테스트의 타입 관계로 바꾸지 않습니다. 지원하지 않는 연결은 원본에 남기고
미투영 범위를 공개합니다. 후속 작업에 필요한 지속 근거만 보존하며 매 수정마다 새
필수 양식, Run이나 기록을 만들지 않습니다. 기존 활성·불명 실행 계약도 유지됩니다.
그래프 갱신이 digest-bound 입력을 다시 쓰거나 다른 효과를 승인하지 않습니다.

```text
lode-agent graph-index <project>
lode-agent world-refresh <project>
lode-agent world-query <project> --query "<affected symbol>" --depth 3 --limit 20
```

관련된 경로만 사용합니다. World/DB 활성화, 전체 재색인, Run/Capsule, watcher 설치나
일상적인 사용자 승인은 일반 작업의 필수 절차가 아닙니다. 갱신 실패 시 해당 미반영
경로·기록과 불확실성을 남기고 현재 원본을 확인하며 독립 작업을 계속합니다. 보존된
옛 그래프는 과거 근거이지 새 코드가 반영됐다는 증명이 아닙니다. 이 완료 지침은
기존 기능을 활용하는 것이며 새 자동 Host lifecycle hook의 구현이 아닙니다.

대표 확인은 작업에 맞게 선택하며 한 묶음의 필수 체크리스트로 만들지 않습니다.
수정은 현재 원본 근거와 지원 이웃 관계를 바꾸고, 새 기능은 목적·구현·테스트 참조를
연결하되 실제 실행 결과를 별도로 확인합니다. 삭제·이름 변경은 과거 자료를 지우지
않으면서 오래된 현재 관계를 제거하고, 병렬 통합은 최종 기준을 갱신합니다. 갱신
실패는 원본 보완이 가능한 상태에서 미반영 범위로 남깁니다.

## 독립 진행 라우팅

하나의 정식 Project가 공통 사용자 방향을 보유합니다. 기존
`.lode/sessions/current.json`은 기본 Session으로 유지하며 추가 Session은
`.lode/sessions/by-id/<session-id>/current.json`에 저장합니다. MCP `session_id`,
CLI `--session`은 요청 대상만 선택하고 기본 Session을 바꾸거나 덮어쓰지 않습니다.
`lode_session_list`가 논리 Session을 조회하며 `lode_session_create`는 선택적
`new_session_id`와 `purpose`를 받습니다. 기존 ID를 다른 목적으로 다시 결속하지
않습니다. 공급자 session ID와는 별개입니다.

`lode_session_list`는 메타데이터를 페이지로 반환합니다. 기본 16개, 최대 64개이며
`max_sessions` / CLI `--max-sessions`로 조절합니다. 필요한 다음 페이지는 반환된
`nextAfterSessionId`를 `after_session_id` / CLI `--after-session`으로 전달합니다.
이 탐색 키는 `default`, Session ID 또는 비정상 디렉터리의 `entry:<name>`이며
Session 라우트가 아닙니다. `default`라는 디렉터리에는 별도 키 `entry:default`를
사용합니다. 오류 항목도 페이지 슬롯에 포함하므로 손상된 기본 Session이나 마지막
비정상 항목에서 반복되지 않습니다. 페이지는 원자적 스냅샷이 아니며 커서가
삭제되면 첫 페이지부터 다시 읽습니다. 남은 항목·개별 실패·공유 디렉터리 오류는
빈 목록과 구별하고, 공통 Project 신원 오류는 그대로 실패시킵니다.
`returnedEntries`는 반환한 슬롯, `inspectedEntries`는 검사한 슬롯입니다.
`readButNotReturnedEntries`는 검사했지만 출력 한도 때문에 보류한 슬롯 수입니다.
기본 신원 확인은 별도로 공개합니다. 보류한 슬롯도 다음 페이지에 포함하므로
이미 읽었다는 이유로 조용히 건너뛰지 않습니다.

이 목록에서만 기존 `session_id` / `--session`은 정확한 작업 미리보기 대상입니다.
native 영속 연결, 공유 호출자 선택과 바깥 요청 라우트를 바꾸지 않으며 선택 없음·
유실 상태도 유지합니다. 미지정 목록은 작업 본문을 읽지 않습니다. 미리보기는 한
Session의 기존 bounded Work/Todo reader를 사용해 오래된 미해결·충돌·부분 범위를
보존합니다. 필요한 누락 근거만 정확한 원문으로 펼치며 bind/save 절차는 없습니다.
최근 기록의 결론에는 원래 사유·남은 작업·미확인이 따릅니다. 최신 요약, ended,
빈 pending, PASS만으로 전체 대표 결과·완료·현재 담당 대화·권한을 만들지 않습니다.
현재 제약·취소가 우선합니다. native 계보 매핑은 관측 당시 선택이며, 나중에 읽은
기록은 참고 자료입니다. 분기 당시 인계·전달·모델 입력으로 확인된 것이 아닙니다.
정확한 managed 입력이 준비됐다는 사실만으로 전달이나 실제 사용을 증명하지 않습니다.

같은 목록의 선택적 `conversation_candidates`는 실제 bounded Host 후보를 기존 저장
매핑과 연결하며, 직계 부모·자식이 아닌 같은 Project의 대화도 조회합니다. 각 selector는
`runtime` (`codex`, `claude`, `opencode`), `native_session_id`, 선택적 `agent_id`,
명시적 `environment_scope: "current"`를 제공합니다. CLI 자동화는
`session-list --conversation-candidates <json-file>`을 사용합니다. Lode가 실제 노출된
bounded Host 도구나 이미 확보한 후보를 필요한 경우에만 조합합니다. 사용자 입력 양식,
자동 메시지·등록·바인딩이나 필수 조회 순서는 추가하지 않습니다.

`conversationDiscovery`는 현재 P5 매핑을 읽는 비영속 P4 뷰입니다. 최대 16개 후보를
검사하며 MCP 텍스트·구조화 결과 중복과 JSON escaping을 포함한 응답 추가분은
32 KiB 안에서 생략 수를 표시합니다. 후보를 주지 않으면 기존 반환값과 라우팅을
유지합니다. 개별 비정상·pending·lost·손상 매핑은 정상 항목을 버리지 않습니다.
읽는 동안 매핑이나 Project 기준이 바뀌면 그대로 공개하며 원자적 스냅샷을 주장하지
않습니다. 매핑 부재가 기본 선택으로 바뀌지 않고, 다른 Host나 신원을 확인할 수 없는
namespace는 로컬 fallback 없이 미지원으로 표시합니다. 저장된 Session 연결·리비전·
digest는 특정 작업 참여, 현재 담당자·활동·연락 가능성이나 모델 입력을 증명하지
않습니다. Host 목록이 없어도 기존 기록으로 일반 작업을 계속합니다.

기록된 Todo의 task·상태·귀속·다음 행동·사유·진행·우선순위도 그래프 검색 근거가 됩니다.
부분 Todo는 `workContentExcerpts`에 원래 인덱스, `todoId`, 하위 필드와 문자 구간,
기록된 상태·귀속 및 선언된 revision 참조를 함께 담습니다. 축약 배열로 다시 번호를
매기지 않습니다. `workContentCoverage.fieldItems.todos`는 전체·부분·누락 항목을
공개합니다. 과거 revision은 별개로 남으며 그래프가 현재 task 상태·충돌·완료나
prior/참조의 현재성을 별도로 추론하지 않습니다. 필요하면 기존의 정확한 원문 확장을
사용합니다. 일반 Work 텍스트는 같은 원문 ID/digest의 동일 task 필드가 이미 나오면
그 위치를 가리킬 수 있으며, 구조화 결과와 알 수 없는 필드는 보존합니다.

각 Session은 로컬 목적, 진행, 활성·불명 작업, 승인과 checkpoint를 유지합니다.
한 Session의 조사 범위 변경이 다른 task를 자동 변경하지 않습니다. 기존 기록을
제자리에 보존하므로 routing을 위해 다시 온보딩하지 않습니다.

## 현재 공통 방향

`lode_project_direction_read` / `project-direction-read`는 현재
`ProjectDirection` 또는 기록 부재를 반환합니다. `input`에 `goal`,
`constraints`, `decisions`, `cancelledActions`를 담습니다. P2 현재 사용자
방향이며 실행 authorization을 주지 않습니다. 현재 실제 사용자 방향을
`lode_project_direction_update`의 조회한 `expected_direction_id` (최초 null)와
`direction` 객체로 게시합니다. CLI는
`project-direction-update --input <direction.json> --expected-direction <id>`입니다.
Lode가 대화에서 typed 입력을 작성하므로 사용자가 양식을 채우지 않습니다.

`.lode/project-direction/current.json`은 불변 revision을 참조합니다. 정확한 기준
비교로 경합한 갱신을 조정하고 시각이나 마지막 쓰기로 의미 충돌을 해결하지 않습니다.
동일 갱신은 기존 방향을 재사용합니다.

그래프 방향 노드는 네 입력 필드를 한정된 `directionEvidence`로 표시하고
`directionContentCoverage`에 생략·잘림을 알립니다. 요약에도 원본 경로·리비전과
현재·과거 상태를 보존합니다. 필요하면 원본 전체 방향을 읽습니다. 부분 그래프
사본은 전체 방향이나 P2 복구 권위가 아닙니다. 옛 제약은 과거 근거이지 현재
공통 지시가 아닙니다.

복구는 정확한 과거 checkpoint 필드와 `currentProjectDirection`을 함께 제공합니다.
배포를 준비하던 Session을 복구했더라도 그 사이 사용자가 전체 Project 배포를
취소했다면 과거 위치를 보존하고 현재 취소를 효과 전에 적용합니다. 과거 기록을
고치거나 옛 권한을 되살리지 않습니다. 그래프의 승인된 결정 사본은 근거로 남으며
실행은 현재 권한과 관련 원본을 다시 확인합니다.

## 보존해야 할 반례

- 미승인·거절 이웃을 관계나 요약으로 승인하지 않습니다.
- 온전한 과거 리비전은 과거로 표시하고 손상과 구분합니다. 교차 Project·변조
  artifact는 단지 stale로 표시하지 않고 제외합니다.
- DB 조회 실패가 원본 코드 탐색의 Product 승인 조건이 되지 않습니다.
- Session 경합이 새 전역 current Session을 선택하지 않습니다.
- 공통 배포 취소는 과거 배포 checkpoint 복구 뒤에도 유지됩니다.
- 읽기 전용 탐색·진입은 방향, 승인이나 복구 기록을 게시하지 않습니다.
- worker 하나의 불명 효과는 확인하되 독립 작업을 막지 않습니다.

[권한 평면](authority-plane-contract.md), [Session 복구](session-recovery.md),
[런타임 구성](../../skills/lode-agent-core/references/runtime-composition.md)을 참고하세요.

## 경로 기준과 기존 Project

Project 내부 참조는 검증된 Project root를 기준으로 한 `/` 상대경로입니다. 생성
Markdown의 `relativePath`는 게시 root 기준이고, href는 해당 문서 위치 기준입니다.
문서의 `../` 링크가 원본 selector의 `..`를 허용하는 것은 아닙니다.

런타임 `project_root`, 저장된 `projectRoot`, 설치의 `pluginRoot`와 root 기반 식별자는
검증된 절대 root와 실제 Session 소유자에 계속 결합됩니다. 새 Project는 `.lode/`를
사용하고 기존 `.head/` 원문과 exact selector는 그대로 유지합니다. 이는 기존 경로
계약의 설명이며, workspace 이동 지원이나 자동 repair 기능이 아닙니다.

## 정확한 선언 선택자

질의 전체가 선언명, 백틱으로 감싼 식별자 또는 호출식이면 일치하는 코드 선언을
반복된 문서 제목보다 먼저 보여줄 수 있습니다. 자연어 질문은 단어나 백틱이 함수명과
같아도 기존 어휘 기반 순서를 유지합니다. 문서는 계속 후보로 남으며, 코드 종류로
제외하거나 의미적 충분성을 판단하지 않습니다. 더 정확한 시작점이 필요하면 정확한
경로나 앵커를 사용합니다.

## 소유 원문 탐색 이어가기

일반 inventory 제한 때문에 관련 원문을 찾지 못했으면 Lode가 기존
`lode_project_graph`에 `inventory_page: true`를 선택할 수 있습니다.
CLI는 `graph-query --inventory-page`입니다. 선택적인 `inventory_paths`
(`--inventory-paths <path,...>`)는 검증된 Project 소유 기록 디렉터리나 파일을
고릅니다. 일반 소스 `paths`와 구분되며 기존 그래프 선택은 바뀌지 않습니다.
사용자는 질문만 말하고, Lode가 유용한 반환 인자를 따라갑니다. 사용자에게 커서를
작성하게 하거나 읽기를 다시 승인하게 하지 않습니다.

이 모드는 노드·간선과 분리된 **타입 미검증 바이트 관측**을 반환합니다.
완전한 raw SHA-256은 손상된 JSON을 포함하여 읽은 바이트를 식별할 뿐,
종류·검토 상태·권위·타입 유효성·현재성을 증명하지 않습니다. 정식 Work·계보·과거
방향 경로에는 기존 `exactRead` 호출 인자가 있고, 해당 reader가 원문과 종속 근거를
다시 검증합니다. 다른 기록은 아직 검사하지 않은 타입 계층의 종속 근거를 밝힙니다.
계보 reader는 선택된 Session·관리 manifest·관리 파일 digest도 계속 검사합니다.
과거 방향의 현재성을 추정하거나 전체 과거 원문 getter를 만들어 안내하지 않습니다.
이 관측 행은 Explorer의 검증된 그래프로 들어가지 않습니다.

각 호출은 디렉터리 열거, 원문 읽기 시도, MCP 전체 응답(이스케이프를 포함한 text와
structured UTF-8 JSON)을 제한합니다. metadata 항목 10,000개와 초과 확인 1개,
디렉터리 열기 시도 10,000회, 이름/EOF 읽기 20,001회, 깊이 8, metadata와 원문 읽기
시도 각각 128 MiB, 원문 하나 16 MiB, 행 512개까지입니다. 응답 512 KiB는 metadata
페이지의 바이트 제한이며 Context Capsule 토큰 계층과 무관합니다. Project/storage
소유권 검사는 이 계수보다 먼저 수행하므로 모든 기존 소유권 검사 비용을 제한한다고
주장하지 않습니다. 다음 요청에서 이름을 다시 열거할 수 있으나, 전역 snapshot을
증명하기 위해 이전 본문을 다시 읽지는 않습니다. 실패·초과 원문도 한 번씩 표시하고
일부만 읽은 해시를 완전한 digest로 제시하지 않습니다.

반환된 `next` 인자는 유용할 때만 사용합니다. `inventory_cursor`는
Project/storage root/query/scope에 묶인 신뢰하지 않는 사전식 탐색 위치이며 복구
방향이 아닙니다. 경계 원문이 바뀌거나 사라지면 `changed-scope`와 실제 재시작 인자를
반환합니다. 제한 안에서 다음 사전식 범위를 확정할 수 없으면 `metadata-bound`와
실제로 발견한 좁은 범위를 반환하고 가짜 커서나 완료를 주장하지 않습니다.
`exhausted-observed-range`는 그 요청에서 관측한 범위만 뜻합니다. 이전 위치에 새로
삽입된 항목과 이전 페이지의 현재성은 미확인이고, 남은 개수를 꾸며내지 않습니다.
자동 반복·저장·Run·승인·영속 아티팩트를 선행 조건으로 요구하지 않으며 독립 작업은
계속할 수 있습니다.


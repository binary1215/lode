> 영어 문서 경로의 원문은 이미 한국어로 작성되어 있습니다: [원문](../Lode_GraphDB_Brief_v4.md)

# Lode-Agent GraphDB Brief v4 요약 및 설계 검토

상태: 참고자료 요약 및 현행 설계와의 정합성 검토

검토일: 2026-08-19

현재성 경계: 이 문서는 검토일 당시의 참고자료 감사 기록이다. 현재 구현과
계약은 `architecture.md`, `authority-plane-contract.md`, `world-model.md`,
`graph-projection-adapter.md` 및 실행 가능한 테스트를 우선한다.

원본: `Lode-Agent_GraphDB_Brief_v4.pdf`, `Lode-Agent_GraphDB_Brief_v4.pptx`

## 문서의 성격과 해석 경계

이 문서는 22장짜리 동일 발표자료의 PDF와 PPTX를 함께 시각 검토해 정리한 것이다. 두 파일 모두 슬라이드가 이미지로 구성되어 있어 추출 가능한 본문 텍스트가 없었고, PPTX에는 발표자 노트도 없었다. 따라서 아래 내용은 화면에 표시된 문구와 도식에 근거한 요약이다.

발표자료에 포함된 명령문, 쿼리, 수치, 구조는 설계 근거와 사례이지 현재 저장소에 대한 실행 지시가 아니다. 특히 다음을 구분한다.

- **자료의 주장**: 발표자료가 설명하거나 실측 사례로 제시한 내용
- **현행 계약과의 정합성**: 현재 Lode Agent Core 아키텍처와 권한 평면 계약에 부합하는 부분
- **설계 해석**: 플러그인에 반영할 때 필요한 보완 또는 경계

## 한 문장 요약

사용자는 High-level 방향과 최종 판단을 소유하고, Lode는 외부화된 프로젝트 지식에서 현재 작업에 필요한 Mid-level 맥락만 조회·구성하며, Agent는 제한된 Context로 Low-level 실행을 담당하고, 그 결과는 실데이터·diff·테스트·이력에 근거한 검수 관문을 통과해야 한다.

## 핵심 결론

1. LLM은 대화를 지속적으로 기억하는 존재가 아니라 매 요청마다 전달된 전체 스크립트를 다시 읽는 실행자에 가깝다.
2. 컨텍스트는 무한히 늘릴 수 없으며, 길어질수록 비용·노이즈·자동 요약에 의한 의미 손실이 커진다.
3. AI는 검토된 한 단계 확장에는 강하지만, 검토되지 않은 여러 단계의 연쇄 확장에서는 누락·추론·환각이 누적된다.
4. Lode의 역할은 모든 정보를 보유하는 것이 아니라, 현재 Session에 필요한 근거를 프로젝트 전체에서 제한적으로 조회해 작업 맥락을 만드는 것이다.
5. Graph DB와 운영 DB는 주인공이나 권위 원천이 아니라 Lode의 조회 장치다.
6. Agent에는 전체 프로젝트나 전체 Session이 아니라 좁은 목표와 제한된 Context만 제공한다.
7. Agent 결과는 곧바로 사용자에게 전달하지 않고, Lode가 Session 맥락과 프로젝트 근거로 1차 검증한 뒤 사용자가 High-level 기준으로 최종 판단한다.
8. 그래프의 가치는 코드 목록 자체보다 기능·코드·변경·기획 의도·운영 근거를 연결해 “무엇이 어디에 구현됐는가”와 “왜 바뀌었는가”를 탐색 가능하게 만드는 데 있다.

## 1. LLM 작동 전제와 실패 모드

### 1.1 대화와 기억의 착시

자료는 LLM의 대화를 “배우가 매번 전체 대본을 다시 읽고 다음 대사를 만드는 것”에 비유한다. 모델이 알고 있는 것은 현재 요청에 포함된 대화와 자료뿐이며, 프롬프트에 없는 정보는 실제 기억처럼 사용할 수 없다.

따라서 AI 활용의 핵심은 정보를 계속 누적하는 것이 아니라 매 작업에서 무엇을 포함하고 제외할지 결정하는 것이다.

### 1.2 컨텍스트 증가의 비용

컨텍스트가 커지면 다음 문제가 함께 증가한다.

- 입력 토큰과 실행 비용 증가
- 중요한 근거가 잡음에 묻히는 현상
- 문맥 한계 근처에서 이전 대화가 자동 요약되는 현상
- 반복 요약으로 초기 약속·조건·뉘앙스가 희석되는 현상
- 근거 없는 연결과 환각 가능성 증가

자료는 이 한계에서 외부 기억, 제한 조회, Session 분리, 검수 관문의 필요성을 도출한다.

### 1.3 한 단계 확장과 연쇄 확장

자료의 구분은 다음과 같다.

- 사용자 방향에서 명세 초안으로 가는 **한 단계 확장**은 AI가 잘 수행할 수 있다.
- 검토된 명세를 작은 작업으로 나누는 **한 단계 확장**도 유효하다.
- 검토 없이 방향 → 설계 → 구현 → 검증을 연쇄 위임하면 각 단계의 누락과 잘못된 가정이 다음 단계의 전제가 된다.
- Low-level 작업 자체가 약한 것이 아니라 목표와 범위가 불명확한 Low-level 실행이 위험하다.

## 2. 검토를 통과한 것만 다음 단계로 전달한다

자료는 AI 산출물을 “그럴듯하지만 틀릴 수 있는 초안”으로 간주한다. 같은 요청도 실행마다 결과가 달라질 수 있으므로 논리적으로 그럴듯하다는 사실만으로 확정하지 않는다.

권장 흐름은 다음과 같다.

```text
사용자 High-level 방향
  -> AI의 Mid-level 초안
  -> 사람의 검토와 교정
  -> 별도 AI의 누락 점검
  -> 사람의 최종 확인
  -> 잘게 나눈 Low-level 실행
  -> Lode의 근거 기반 검수
  -> 사용자의 최종 판단
```

검수 근거로는 실데이터, diff, 테스트, 실행 이력처럼 다시 확인할 수 있는 증거를 사용한다. 여러 작업을 한 번에 “전부 처리”하도록 넘기기보다 작업 단위를 명시적으로 열거해 혼합·누락·임의 보완 가능성을 줄인다.

## 3. Lode-Agent의 역할 분담

### 3.1 User: High-level 권위와 최종 판단

사용자는 다음을 소유한다.

- 방향과 의도
- 우선순위
- 성공 기준
- 중요한 제품 판단
- 검수된 결과에 대한 최종 승인

목표는 사람이 일을 보지 않는 것이 아니라, 사람이 관찰하고 판단하는 층위를 Low-level 실행에서 High-level 결과와 방향으로 끌어올리는 것이다.

### 3.2 Lode: High와 Mid 사이의 변환기

사용자는 Lode와 지속적으로 방향·뉘앙스·우선순위를 교정한다. Lode는 이를 현재 주제에 필요한 작업 맥락으로 변환한다.

Lode의 책임은 다음과 같다.

- 목적, 제약, 판단 기준 정리
- 현재 Session 개설 및 유지
- 필요한 정보 범위 결정
- 프로젝트 저장소에서 필요한 조각만 조회
- 작업을 제한된 실행 단위로 분해
- Agent 결과를 Session과 프로젝트 근거로 1차 검수
- 검수된 결과를 사용자에게 올려 최종 판단을 받음

### 3.3 Session: 현재 주제의 작업 기억

Session은 한 Lode가 한 주제를 다루는 작업 단위다. 목적, 현재 상태, 진행 상황, 완료 이력을 파일 등 외부 매체에 기록해 긴 대화에서도 같은 주제를 유지하고 다른 주제와 섞이지 않게 한다.

Session은 프로젝트 전체를 복제하지 않는다. 현재 작업의 목적과 맥락만 보유하며 나머지는 필요할 때 조회한다.

### 3.4 Agent: 제한된 Low-level 실행자

Lode는 방향이 맞으면 일을 구현·조사·검증·문서화 같은 실행 단위로 나눈다. Agent에는 다음만 제공한다.

- 좁은 목표
- 제한된 Context
- 명시적 실행 범위
- 검증 기준

전체 프로젝트와 전체 Session을 통째로 제공하지 않는다.

## 4. 프로젝트 기억과 조회 계층

자료는 프로젝트 전체를 다음 자원의 결합으로 본다.

- 코드
- 문서
- Graph DB
- 운영 DB
- Notion과 같은 협업 자료
- 변경 이력

이 자원은 Session 안에 전부 적재되지 않는다. Lode가 현재 질문에 필요한 정보만 조회한다.

```text
프로젝트 전체 근거
  -> Lode의 제한 조회
  -> 현재 Session의 작업 맥락
  -> 제한된 Agent 실행 Context
```

Graph DB는 기능·코드·DB·변경 이력·기획 의도를 연결하고, 운영 DB는 실제 사용자 데이터와 현재 상태를 확인하는 역할로 제시된다. 둘 다 판단 주체가 아니라 Lode가 근거를 찾는 장치다.

## 5. 그래프 구조와 실제 질의 사례

### 5.1 실물 그래프

자료는 2026-07-02 시점의 실물 렌더를 다음 규모로 제시한다.

- 10,724 nodes
- 30,497 edges
- 주요 범주: Feature, 화면 코드(FE), 서버 코드(BE), DB, 변경 이력(Commit·Ticket)

코드 변경 시 파이프라인이 그래프를 갱신해 기능과 코드 연결을 최신화한다고 설명한다. 여기서 코드 노드 하나보다 가치 있는 것은 사용자 언어 ↔ 코드, 코드 ↔ 변경, 변경 ↔ 기획 의도를 잇는 관계다. 코드 노드는 관계망에서 구현 위치를 가리키는 좌표에 가깝다.

### 5.2 “전송 버튼을 누르면 어떤 코드가 움직이는가?”

자료의 질의는 사용자 언어인 `메시지 전송` Feature에서 구현 코드를 따라간다. 제시된 경로는 다음과 같다.

```text
Feature: 메시지 전송
  -> UIInteraction: 전송 버튼 click
     ChatInputArea.tsx:333 -> handleSend()
  -> Route: send_message
     POST /sessions/{session_id}/messages
     chat_messages.py:223
  -> Service 로직 4개
     메시지 저장
     AI 응답 스트리밍
     응답 버전 관리
     프롬프트 조립
```

이 사례가 보여주는 것은 파일명 검색이 아니라, 사용자 기능에서 시작해 화면 이벤트·API 경로·실제 서비스 로직까지 관계를 따라가는 탐색이다.

### 5.3 “이 기능은 왜 이렇게 바뀌었는가?”

`메시지 전송` Feature에서 Commit을 거쳐 Ticket 원문까지 탐색해 변경 이유를 찾는다. 자료는 최근 변경 두 건이 모두 크레딧 정책 결정과 관련되어 있음을 보여준다.

- Ticket #412: 크레딧 부족 시 채팅 입력을 끊고 결제 페이지로 강제 이동하던 UX를, 채팅 입력을 유지한 채 인라인 결제 흐름을 제공하도록 변경
- Ticket #431: 작품별 크레딧 관리의 복잡성을 줄이기 위한 사용자 단위 정책 전환

Git 이력은 “무엇이 바뀌었는가”를 commit, 파일, diff 중심으로 보여줄 수 있지만, 이 사례의 그래프는 변경을 Feature 단위에 연결하고 Ticket의 배경·문제·해결 원문까지 함께 반환한다. 즉, Git을 대체하는 단일 저장소라기보다 제품 의미와 변경 근거를 연결하는 의미 계층의 가치를 보여준다.

## 6. A/B 사례가 보여주는 근거의 차이

실제 사용자 피드백은 시작 상황의 장소와 호감도 값이 AI에 전달되지 않는 것 같다는 내용이다. 자료는 두 에이전트의 진단을 비교한다.

### B — 프로젝트 맥락이 없는 에이전트

- 코드만 분석해 경계값 관련 실존 버그를 발견
- 논리와 파일·라인 인용은 정확함
- 그러나 해당 사용자의 작품은 그 버그의 발동 조건에 해당하지 않음
- 결과적으로 논리적으로 완결된 오진이 됨

### A — Lode 맥락을 받은 에이전트

- 그래프에서 `시작 상황 -> AI` 경로 확인
- 운영 DB에서 문제 작품을 특정
- 시작 가이드 자체에 필요한 정보가 없고, 시뮬레이터의 변수 기본값과 사용자의 기대 값이 모순되는 것을 확인
- 실데이터로 재현 가능한 원인을 확정

자료는 A가 B보다 토큰을 약 3~5배 사용했다고 기록한다. 비용 증가는 있었지만, 잘못된 진단이 후속 구현으로 이어지는 비용을 차단했다는 주장이다.

이 결과는 한 실제 사례의 관찰이다. 일반적인 정확도 향상을 입증한 통계적 벤치마크로 확대 해석해서는 안 된다. 다만 “코드 논리만으로는 실제 사용자 상태를 확정할 수 없다”는 설계 근거로는 유효하다.

## 7. 현재 Lode Agent Core 목표와의 정합성

### 7.1 직접 부합하는 부분

| 발표자료의 원칙 | 현행 설계 계약 |
| --- | --- |
| High는 사람이 보고 Mid는 Lode가 만들며 Low는 Agent가 실행 | 사용자 권위, Whole-plan Lode, bounded Executor의 분리 |
| Lode는 필요한 조각만 조회 | Context Compiler의 minimum-sufficient context |
| Session은 현재 주제만 보유 | provider session과 분리된 Lode Session 및 immutable artifact 기반 복원 |
| 전체 프로젝트 지식은 외부화 | Repository World Model, GraphSnapshot, 문서 projection |
| Agent는 좁은 목표와 Context만 받음 | ExecutionContract와 ContextCapsule |
| 결과는 Lode 검수 후 사용자 판단 | ResultPacket, Fresh Review Lode, ReviewDecision |
| diff·데이터·테스트·이력으로 검증 | evidence-linked execution lineage |
| Graph DB는 조회 장치 | rebuildable, replaceable GraphProjectionAdapter/GraphDB adapter |
| 사용자 언어에서 코드와 변경 이유로 탐색 | Feature/Capability ↔ code/test/change/evidence temporal graph |

### 7.2 수정 없이 가져오면 안 되는 부분

#### 관계 방향

발표자료의 예시 쿼리는 다음 방향을 사용한다.

```cypher
MATCH (f:Feature {name:'메시지 전송'})-[:IMPLEMENTED_BY]->(impl)
RETURN impl
```

현행 계약의 정본 관계 방향은 구현 엔티티가 제품 엔티티를 `IMPLEMENTS`하는 방향이다.

```text
File 또는 Symbol -[:IMPLEMENTS]-> Feature
```

사람에게는 “Feature가 이 코드로 구현됨”이라는 역방향 표현을 보여줄 수 있지만, 저장 계층에 `IMPLEMENTED_BY`를 별도 정본 edge로 추가하면 동일 의미가 두 관계와 두 identity로 중복된다. 따라서 자료의 질의 의도는 유지하되 저장 스키마는 현행 canonical direction을 따른다.

#### Graph DB의 권위

발표자료는 Graph DB를 강력한 프로젝트 조회 장치로 설명하지만, 그래프가 유일한 복구 원천이어야 한다고 주장하지는 않는다. 현행 계약은 이를 더 엄격히 정의한다.

- 사용자 승인 canon은 제품 의도에 대한 권위다.
- 실행 가능한 코드와 설정은 현재 구현에 대한 권위다.
- 검증 Evidence와 승인된 ResultPacket은 실행 결과에 대한 권위다.
- GraphSnapshot은 이들을 연결하는 재구축 가능한 물질화 뷰다.
- Markdown, Obsidian, Notion은 GraphSnapshot의 사람용 projection이다.

따라서 “그래프가 문서보다 정본”이라는 방향은 유지하되, “그래프가 모든 도메인의 유일한 정본”으로 확대하지 않는다.

#### Git과 변경 이력

자료의 `Commit -> Ticket` 탐색은 Git이 존재하는 사례다. 현재 제품 계약에서는 `ChangeSet`이 provider-neutral 논리 변경 단위이며 Git은 선택적 증거다.

```text
ChangeSet
  -> changed revisions / affected Features / ResultPacket / ReviewDecision
  -> optional VcsEvidence
  -> optional GitCommit
```

Git이 없어도 변경 DAG, 그래프 identity, 검수와 복구가 성립해야 한다. Git이 있으면 commit·diff·ref를 증거로 보강한다.

#### 실시간 자동 갱신

발표자료는 코드 변경 시 파이프라인이 그래프를 자동 갱신하는 운영 사례를 제시한다. 현행 구현은 content-addressed snapshot과 명시적 indexing을 우선하며, 실시간 watcher·자동 promotion·자동 병합은 아직 계약된 완성 기능이 아니다. 자동 갱신은 다음을 보존하는 후속 기능이어야 한다.

- immutable revision과 다중 parent DAG
- digest 검증
- freshness 판정
- 후보 관계와 승인된 관계의 분리
- 실패 시 재구축 가능성

## 8. 플러그인 설계에 반영할 원칙

### 8.1 자료에서 강화되는 원칙

1. **Context Compiler를 중심 경로에 둔다.** 그래프 조회 결과를 통째로 전달하지 않고, 작업 관련성·권위·신선도·예산에 따라 최소 충분 Context로 컴파일한다.
2. **질문을 사용자 언어의 제품 개념에서 시작한다.** 파일이나 함수명을 모르는 사용자도 Feature·Capability에서 구현과 변경 근거로 이동할 수 있어야 한다.
3. **정적 코드와 운영 사실을 구분해 결합한다.** 코드 경로가 가능성을 설명하고, 운영 데이터가 실제 사례의 조건과 상태를 확인한다.
4. **검수 관문을 데이터 모델로 만든다.** Agent의 주장, Evidence, ResultPacket, ReviewDecision을 분리하고 승인 전에는 다음 계획의 정본 입력으로 올리지 않는다.
5. **변경 이유를 첫 번째 시민으로 다룬다.** ChangeSet을 Feature, Decision, Ticket/Requirement, 코드 revision, 검증 결과에 연결한다.
6. **탐색은 항상 bounded traversal이어야 한다.** 관계 allowlist, depth, node/edge limit, freshness, confidence, 포함·제외 사유를 고정하고 digest로 재현한다.
7. **그래프와 문서를 분리한다.** GraphSnapshot은 관계 탐색 모델이고 Markdown·Obsidian·Notion은 결정적 projection이다. 문서 편집은 즉시 정본 변경이 아니라 검토 대상 candidate다.

### 8.2 권장하는 다음 구현 순서

발표자료가 보여준 최종 사용 경험을 현재 계약 위에서 구현하려면 다음 순서가 적절하다.

1. `FeatureGroup`, `Capability`, `Feature`, `Requirement`, `Decision` projection 추가
2. `File`, `Symbol`, `Test` revision과의 다대다 `IMPLEMENTS`·`VERIFIED_BY` mapping candidate 생성
3. Evidence와 ReviewDecision을 통한 candidate 승인·거부·promotion 구현
4. provider-neutral `ChangeSet`과 source/revision DAG 연결
5. Feature → 구현 경로, Feature → ChangeSet → Decision/Requirement 경로용 bounded query 추가
6. Context Compiler가 query digest와 포함·제외 근거를 Capsule에 기록하도록 통합
7. 동일 GraphSnapshot에서 Markdown baseline projection 생성
8. 로컬 구현과 동일 identity를 보존하는 선택적 GraphDB adapter 추가
9. 운영 DB는 별도 read-only Runtime/Operational Evidence adapter로 연결

GraphDB를 먼저 붙이는 것보다 semantic contract와 query conformance를 먼저 완성해야 저장소 교체가 제품 의미를 바꾸지 않는다.

## 9. 슬라이드별 개요

| 장 | 주제 | 핵심 내용 |
| ---: | --- | --- |
| 1 | 전체 구성 | LLM 한계와 실제 Lode-Agent·지식 그래프·검수 시스템 소개 |
| 2 | LLM 작동 원리 1 | 매 응답은 전체 대화와 최신 메시지를 다시 읽는 방식 |
| 3 | LLM 작동 원리 2 | 토큰 한계, 자동 요약, 초기 맥락 희석 |
| 4 | 문제 정의 | 컨텍스트 증가에 따른 비용·노이즈·환각 |
| 5 | 단계별 품질 | 검토된 한 단계 확장과 무검토 연쇄 확장의 차이 |
| 6 | Review gate | 재현 가능한 근거를 통과한 산출물만 다음 단계로 전달 |
| 7 | 검수 후 확장 | 사용자와 AI가 단계별로 초안·검토·분해 |
| 8 | 실제 시스템 | Lode-Agent, 그래프, 검수 관문의 운영 사례 소개 |
| 9 | 운영 관점 | 사용자는 High-level 방향과 성공 기준을 관찰 |
| 10 | Lode | High↔Mid 변환기, 사용자 의도의 작업 맥락화 |
| 11 | Session | 현재 주제의 목적·상태·완료 이력을 보존하는 작업 기억 |
| 12 | 프로젝트 기억 | 코드·문서·DB·Notion·변경 이력의 외부화 |
| 13 | Retrieval | Lode는 현재 Session에 필요한 조각만 조회 |
| 14 | Agent 실행 | 좁은 목표와 제한 Context로 Low-level 작업 수행 |
| 15 | Lode 검수 | Agent 결과를 Session·diff·데이터·테스트·이력으로 확인 |
| 16 | Graph/운영 DB | 판단 주체가 아닌 Lode의 조회 장치 |
| 17 | 실물 그래프 | 10,724 nodes, 30,497 edges 및 기능·코드·DB·변경 연결 |
| 18 | 구현 경로 질의 | 메시지 전송 Feature에서 UI·Route·Service까지 탐색 |
| 19 | 변경 이유 질의 | Feature → Commit → Ticket으로 정책 결정 원문 추적 |
| 20 | Git과 그래프 | 변경 목록과 제품 의미·기획 배경 연결의 차이 |
| 21 | A/B 사례 | 코드만 본 완결된 오진과 실데이터로 확정한 진단 비교 |
| 22 | 요약 | High는 사용자, Mid는 Lode, Low는 Agent, 검수 후 판단 |

## 최종 판단

이 발표자료는 현재 Lode Agent Core의 궁극 목표와 높은 수준에서 잘 맞는다. 특히 제한 조회, Session 분리, High/Mid/Low 역할 분담, 근거 기반 검수, 제품 언어에서 코드와 변경 이유로 이어지는 그래프 탐색은 현행 Context Compiler와 Unified temporal GraphSnapshot 방향을 직접 강화한다.

다만 자료는 운영 사례를 설명하는 brief이고, 현재 프로젝트는 그 경험을 provider-neutral하고 재현 가능한 계약으로 일반화해야 한다. 따라서 예시 edge 방향, Git 중심 변경 경로, 실시간 갱신 표현을 그대로 복제하지 않고 다음 원칙을 유지해야 한다.

```text
도메인별 canon과 실행 가능한 상태
  -> immutable lineage와 provider-neutral ChangeSet
  -> typed temporal GraphSnapshot
  -> bounded Context Compiler retrieval
  -> ExecutionContract / Agent / ResultPacket
  -> Fresh Lode ReviewDecision
  -> Markdown / Obsidian / Notion projection
```

이 구조에서는 그래프가 단순 문서 검색 인덱스를 넘어 FeatureGroup·Feature·코드·변경·디자인·결정·운영 Evidence를 상호 탐색하는 중심 의미 계층이 된다. 동시에 권위, 실행, 검수, 문서화의 경계를 유지하므로 Graph DB 장애나 Git 부재가 프로젝트 의미와 이력을 소실시키지 않는다.

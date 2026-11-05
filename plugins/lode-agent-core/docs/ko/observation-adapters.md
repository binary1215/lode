> 이 문서는 [Common Observation contract and adapters](../observation-adapters.md)의 한국어판입니다.

# 공통 Observation 계약과 어댑터

## 작업 범위 소스 수집

`lode_source_context` / `lode-agent source-context`는 Lode가 선택한 현재 소스를
수집해 기존 Context Compiler에 넣습니다. 사용자는 작업을 대화로 설명하고,
Lode가 정확한 파일 경로와 함수 이름을 구성합니다. JSON·ID·해시를 직접 작성하거나
전체 World 스캔, 재인덱싱, Product 온보딩, GraphDB를 요구하지 않습니다.
작업만 전달하면 Lode가 범위를 선택하는 단계로 이어지며 단어 매칭으로 의미를 추측하지 않습니다.

실제 수집기는 LSP가 아닌 **Python 표준 AST**입니다. Host PATH의 Python 3.8+
또는 신뢰된 절대경로 `LODE_PYTHON`을 사용합니다. `HEAD_PYTHON`도 호환 이름으로
읽으며, 두 설정값이 충돌하면 실행기를 조용히 선택하지 않고 거부합니다.
배포된 worker를 중립 디렉터리에서
`-I -S -B`로 실행해 전달된 소스만 구문 분석하며, 프로젝트 모듈을 import하거나
네트워크 포트를 열지 않습니다. 모듈의 명확한 비장식 함수 또는 호출 전에 무조건
정의된 로컬 함수의 직접 이름 호출 후보를 보고합니다. import·별칭·속성·동적 호출,
이름 가림, 장식자, 조건부 정의, 미해결 상위 스코프는 미확인 이유를 남깁니다.
중첩 본문·기본 인자·장식자 평가의 모든 호출까지 다루지는 않습니다.
실행 시의 의미적 진실이나 프로그램 전체 완전성을 주장하지 않습니다.

dirty 파일을 포함해 실제 bytes를 digest로 묶고, 경로 이탈·심볼릭 링크·수집 중 변경과
비UTF8·BOM·단독 CR 입력은 조용히 변환하지 않습니다. AST의 UTF8 byte 좌표를
CRLF·비BMP 문자를 포함한 UTF16 좌표로 변환합니다. 파일·원본 응답은 각각 기존 v0의
1 MiB 한도를 따릅니다. 일반 소스 발췌는 생략 bytes를 공개하며 공통 Observation의
64 KiB 문자열 계약을 지킵니다. 한 번에 Lode가 선택한 need 32개까지 처리합니다.
worker 기본 제한은 15초이며 Host가 최대 120초까지 지정할 수 있습니다.
stdout/stderr 제한과 취소는 유한한 종료를 위한 운영 한도이지 충분성 판단이 아닙니다.

`retain`을 선택한 성공은 공통 P3 `source.structural-context` 관측과 별도로 해시된
원본 소스·응답 bundle을 저장합니다. 기본값인 일시적 증거도 Context에서 같은 검증을
받지만 영속 복구를 주장하지 않습니다. 재시작 후 재사용은 현재 소스, 질의,
Python/AST/tokenizer, worker·normalizer 식별자를 대조합니다. 실패는 확보한 원본
응답을 보관하고 동일 소스·profile·질의·결과의 반복 기록은 합칩니다.
`lode_source_observation_read`로 결과에 자동 반환된 성공/실패 key를 조회합니다.
보관은 작업 내 증거 선택이지 추가 사용자 승인 단계가 아닙니다. 캐시·관측·결과·미리보기는
Product Canon, ReviewDecision, P2 checkpoint나 방향을 변경하지 않습니다.

과거 조회는 현재 파일이 바뀌었어도 보관 자료의 무결성을 검증해 원본을 제공합니다.
`sourceState`가 stale/unavailable 및 현재 Context 적격성을 별도로 표시합니다.
손상·누락된 후보는 이유를 알리고 원본을 보존하며, 유효한 다른 후보나 새 수집으로
복구합니다. 독립 need가 함께 사라지지 않습니다. 선택적 보관 실패도 검증된 일시적
증거를 무효화하지 않지만 `retentionPending`이 영속 handoff 주장을 막습니다.
`SourceContextResult`는 P4 wrapper입니다. 내부 `ContextCapsule`은 P2 타입의
**미보관·미바인딩 미리보기**이며 복구 상태 갱신이 아닙니다.
`SourceCollectionFailure`는 P3, 프로세스·캐시는 P5입니다. 기존 0.6 권한 경계는
계속 유효하며 새 타입 분류만 추가합니다.

`pendingNeeds`는 그 증거에 의존하는 판단에만 적용됩니다. 독립 need는 계속 수집·컴파일하며,
소스 텍스트가 CALLS 요구를 대신 충족하지 않습니다. `observed`는 선택된 관측의 포함을
뜻하며 작업 완료·전체 호출 그래프 완전성·Lode의 의미적 수락을 뜻하지 않습니다.
CLI 중단 및 MCP 취소·연결 종료는 소유 worker가 종료된 후 정리됩니다.

이 계약을 변경하기 전에 [아키텍처](architecture.md)와 [권한 평면](authority-plane-contract.md)을 읽으세요. 릴리스 전용 증거는 [Release observation](release-observation.md)에, 대상별 전달 이력은 [전달 상태 관측](delivery-observation.md)에, 작업별 정확한 포함 방식은 [Context Compiler](context-compiler.md)에 설명되어 있습니다.

상태: 공급자 중립 P3 증거 문법과 P4 프로젝션이 구현되었습니다.

## 경계

공통 계약은 제품 어휘를 통일하지 않고 증거의 형태, 계보, coverage, replay와 권한만 표준화합니다. `ObservationTypeDescriptor`는 닫혀 있고 범위가 제한된 payload schema만 선언합니다. Feature, policy, 성공 조건, 인과 관계, tool route 또는 제품 의미를 선언할 수 없습니다.

adapter는 정확한 `ObservationSourceBinding`과 제한된 input을 제공합니다. Core는 불변 `ObservationRecord`와 하나의 `ObservationCollectionReceipt`를 만듭니다. 정확한 source record에 대한 결정적 계산은 별도의 `DerivedObservationRecord`를 만들며, 관찰된 사실을 다시 쓰지 않습니다.

credential, provider session, process ID, socket과 source cursor는 Host 로컬에 남습니다. binding에는 credential reference name만 나타날 수 있고 observation record에는 복사되지 않습니다. replay identity는 정확한 adapter key, adapter version, source-scope digest, source-event-key digest 범위로 제한됩니다. 해당 binding 안의 동일 replay는 같은 record로 수렴하고 내용이 다르면 fail closed됩니다. 서로 독립적인 source binding은 충돌 없이 같은 upstream event key를 재사용할 수 있습니다.

Core는 같은 디렉터리의 atomic hard-link commit으로 각 create-only Observation artifact를 발행합니다. 따라서 동시 writer는 기존 replay key를 대체할 수 없습니다. 동일한 내용은 수렴하고, 서로 다른 내용을 가진 패배 writer는 receipt를 만들기 전에 중단합니다. receipt는 실제로 이겼거나 이미 존재한 record identity에 대해서만 기록되므로, 후속 reader는 record/receipt split-brain을 물려받지 않습니다. 이 process-safe storage fence는 ingestion 승인이나 semantic judgment를 추가하지 않습니다.

## Coverage와 graph

Coverage는 complete, sampled, partial, unknown으로 명시됩니다. bounded enumeration이 query digest, 동일한 examined/source total과 omission 0을 제공할 때만 complete coverage를 받아들입니다. adapter가 sample을 complete라고 주장할 수 없습니다.

재구축 가능한 공통 `ObservationStatusProjection`은 `CONFORMS_TO`, `EVIDENCED_BY`, `DERIVED_FROM`을 만듭니다. impact, motivation, measurement, ownership, success 또는 Feature link를 추론하지 않습니다. Delivery specialization은 정확히 보존된 World `FileRevision`을 검증한 뒤에만 `AT_REVISION`을 추가할 수 있고, declared revision 문자열에는 이 edge를 만들지 않습니다. 제품 해석은 Lode가 작성한 `ProductHypothesis` 또는 기존 review-gated candidate flow가 담당합니다. `ProductSignal`은 원문 손실이 없는 사람/source 진술을 위해 유지되며 임의 payload field에서 만들어지지 않습니다.

릴리스 증거는 엄격한 specialization이며 generic adapter로 대체되지 않습니다. `BranchStateObservation`, `DeploymentResultObservation`, `ReleaseObservation`은 정확한 Git reachability, approval, commit, ref와 lineage 검사를 유지합니다.

대상별 delivery history도 공통 계약을 얇게 specialization합니다. 공통 불변 record와 receipt를 재사용하고, receipt time이 아니라 explicit sequence/predecessor evidence에서 현재 상태를 파생하며, 충돌은 unknown으로 남기고 관측되지 않은 대상의 completeness를 추론하지 않습니다. 배포 엔진이나 승인 gate를 추가하지 않습니다.

검증된 `delivery.state` record는 graph 전용 `AT_REVISION` proof label을 부여하므로 이 타입은 전용 delivery writer에 예약됩니다. 일반 ingestion과 registered generic adapter는 자기 선언된 binding을 신뢰하지 않고 이 타입을 거부합니다. custom Observation type을 닫거나 사람의 확인 단계를 추가하는 것이 아니라, 기계적으로 강화된 claim을 동일 Project의 정확한 World/revision verifier 뒤에 두는 경계입니다.

## Host adapter SDK와 reference file adapter

`ObservationAdapterRegistry`는 process-local P5 Host registry입니다. adapter instance를 하나의 정확한 ready Lode Project, `ObservationSourceBinding` 및 `ObservationTypeDescriptor`에 binding한 다음 structured Host input과 같은 Core verifier를 통해 collection을 위임합니다. 서로 다른 Project에서는 같은 source alias를 독립적으로 사용할 수 있지만 opaque source ID와 collection은 Project-bound입니다. registration에는 임의의 Core source-count gate가 없습니다. 비지속 P4 discovery view는 page당 최대 64개 source를 반환하며 exact type/adapter/availability filter와 현재 filtered registry projection에 binding된 opaque cursor를 제공합니다. source discovery에는 authority나 mutation effect가 없으므로 stale cursor는 명시적 resynchronization metadata와 함께 첫 page로 다시 시작하며 collection은 정확한 현재 Project와 source ID를 계속 재검증합니다. registry, source alias, source path, credential, cursor, provider identity와 polling state는 프로젝트에 기록되지 않습니다. Core는 project adapter code를 discover하거나 dynamically load하지 않으며, trusted Host composition만 adapter instance를 register할 수 있습니다.

각 source projection은 bounded descriptor shape summary를 포함합니다. type/version, form, 최대 16개의 field key/type/required 조합과 omission count만 노출합니다. Host는 bounded operational availability state(`unknown`, `ready`, `auth-missing`, `rate-limited`, `unavailable`), timestamp, retry timestamp, stable reason code만 붙일 수 있습니다. 이 hint는 semantic authority가 false인 P5 operational evidence이며 product relevance ranking, freshness sufficiency 또는 instruction이 될 수 없습니다.

제품별 adapter는 authentication, API query, pagination, rate limit, webhook acknowledgement와 cursor storage를 Core 외부에서 소유합니다. 하나의 bounded result를 공통 계약으로 normalize하고, Core는 검증된 P3 record와 receipt만 persist합니다. optional adapter가 없어도 Lode는 막히지 않으며 adapter output은 제품 의미를 부여할 수 없습니다.

`JsonEventFileObservationAdapter`는 CI 또는 webhook spool integration을 위한 provider-neutral reference입니다. absolute Host path의 regular non-symlink JSON file 하나를 open하고, 열린 file identity를 검증하며, 512 KiB read bound를 적용한 뒤 collection 전에 raw event key와 전체 evidence를 hash합니다. source path, raw event key, source alias와 credential reference name은 persist되지 않습니다. event file에는 product-shaped event만 들어갑니다.

```json
{
  "schemaVersion": 1,
  "eventKey": "build-42",
  "subject": { "type": "example.ci.target", "key": "app" },
  "form": "event",
  "temporalScope": {
    "observedAt": "2026-09-01T01:00:00.000Z",
    "start": null,
    "end": null
  },
  "coverage": {
    "state": "complete",
    "basis": "enumerated-bounded-query",
    "queryDigest": "<sha256>",
    "examinedCount": 1,
    "sourceReportedTotal": 1,
    "omittedCount": 0,
    "cursorStartDigest": null,
    "cursorEndDigest": null
  },
  "payload": { "succeeded": true }
}
```

고급 one-shot Host configuration은 binding, descriptor와 absolute event path를 제공합니다. `sourceKey`는 optional이며 생략하면 정확한 binding과 descriptor에서 derive됩니다.

```json
{
  "binding": {
    "adapterKey": "head.json-event-file-observation",
    "adapterVersion": "0.1.0",
    "sourceScopeDigest": "<sha256>",
    "credentialReferenceNames": []
  },
  "descriptor": {
    "typeKey": "example.ci.build-result",
    "typeVersion": "1.0.0",
    "forms": ["event"],
    "payloadSchema": {
      "fields": [{ "key": "succeeded", "type": "boolean", "required": true }],
      "additionalFields": false
    }
  },
  "eventFile": "<absolute-host-path>"
}
```

`observation-file-ingest`는 trusted Host/CI integration에서만 실행합니다. 의도적으로 MCP file-path surface를 제공하지 않습니다. 일반 대화형 사용에서는 model이나 user에게 path와 provenance JSON을 작성하게 하지 말고 configured Host integration을 호출해야 합니다. reference adapter는 one-shot이며 daemon, scheduler, remote connector 또는 자동 product interpretation을 제공하지 않습니다.

## 대화형 configured-source 흐름

trusted Host composition은 Project-bound registry를 `serveMcp`에 전달합니다. provider Lode가 필요한 exact `typeKey` 하나를 선택한 뒤 `lode_observation_prepare`가 read-only reuse-first flow를 수행합니다. 현재 exact Observation ID를 먼저 query하고 source를 선택하거나 collect하지 않은 채 일치하는 configured source ID를 반환합니다. 기존 evidence가 의미적으로 충분하지 않고 durable current evidence가 실제로 필요할 때만 Lode가 필요에 따라 `lode_observation_sources`를 page/filter하고 선택한 ID로 `lode_observation_collect_source`를 호출합니다.

```text
trusted Host configuration
  -> lode_observation_prepare(exact Lode-selected typeKey)
  -> existing exact Observation IDs first
  -> lode_observation_sources only for paging or diagnosis
  -> opaque Project-bound sourceId
  -> lode_observation_collect_source
  -> verified P3 ObservationRecord + ObservationCollectionReceipt
```

preparation projection은 semantic sufficiency를 판단하거나 lexical overlap으로 relevance를 추론하거나 source를 선택하거나 어떤 것도 persist하지 않습니다. provider Lode가 conversation 안에서 그 판단을 수행합니다. 이 경로에서 model과 user는 file path, credential reference, binding, descriptor, digest, coverage claim, provider identity 또는 source alias를 제공하지 않습니다. Core는 adapter가 source에 접근하기 전에 Project readiness를 검증합니다. Host composition이 없으면 optional adapter unavailable 상태를 명시하며 user-authored provenance로 fallback하거나 공통 계약을 약화하지 않습니다. embedding Host는 고급 CLI composition에서도 같은 injected registry를 사용할 수 있지만 일반 standalone CLI는 adapter code나 configuration을 dynamically load하지 않습니다.

## Metric evidence workflow

Metric workflow는 공통 계약을 얇게 사용하는 provider-neutral 경로이며 두 번째 analytics store가 아닙니다. `lode_metric_define`은 unit과 desired direction을 포함한 versioned metric shape를 등록합니다. 정확한 replay는 idempotent하며, 동일 metric key와 version 아래에서 shape가 충돌하면 이후 lookup을 모호하게 만들지 않고 새 version을 사용하도록 요청하며 실패합니다.

`lode_metric_observe`는 정확한 subject, value, time scope, source scope, 알려진 경우 sample size, coverage 및 collection-adapter identity를 기록합니다. Host가 observation time을 다시 제공하지 않고 같은 event를 retry하면 Core는 durable event time을 재사용하며, 같은 source event 아래에서 content가 달라지면 계속 fail closed됩니다. `lode_metric_compare`는 정확히 같은 descriptor, subject, unit 및 direction에 대해서만 numeric difference를 허용합니다. Adapter key, adapter version, adapter descriptor digest, source scope, snapshot/aggregate form, period duration, sample size 또는 coverage state가 달라도 approval gate를 추가하지 않습니다. Numeric comparison은 계속 사용할 수 있지만 결과는 조건을 same, different, unknown으로 표시하고 normalization이 적용되지 않았음을 밝히며, like-for-like result로 보이지 않도록 derived coverage를 낮춥니다.

`lode_metric_assess`는 P3 ProductHypothesis만 기록하고 causality가 성립하지 않았음을 항상 명시합니다. 후속 제안은 별도 metric 형식화 호출 없이 정확한 평가 hypothesis ID를 인용해 `lode_product_initiative_propose`로 만듭니다. Product Initiative candidate일 뿐이며 승인에는 기존의 명시적 user review가 필요합니다. `lode_metric_status`와 `lode_metric_trace`는 bounded read-only P4 view입니다. 어떤 operation도 Product Canon, ReviewDecision, Conformance disposition 또는 P2 recovery direction을 쓰지 않습니다.

## Context와 사용법

### 측정 근거의 저장 완료와 파생 World 갱신

Metric 정의·관측·비교는 원본 저장 뒤 World 투영이 실패해도 정확한 저장 ID를
반환합니다. 정상 `worldModel`은 기존 `worldModelId`·`graphSnapshotId`를 유지하며,
후속 투영만 실패한 경우 저장 결과와 함께 `worldModel: {status: "deferred",
reasonCode, ordinaryWorkBlocked: false}`를 전달합니다. 제한된 사유 코드에 원문 오류
메시지·경로·stack을 노출하지 않습니다.

deferred는 파생 갱신 미완료이지 예약된 재시도나 파생 쓰기 0회의 뜻이 아닙니다.
완료한 근거를 다시 작성하거나 강제 refresh할 필요는 없습니다. 입력·identity/digest·
permission·원본 게시 오류와 observation/receipt 또는 descriptor/comparison의
부분 저장은 계속 오류입니다. 정확한 재시도의 기존 수렴·관측 시각 재사용은 유지하며,
재시도나 World view가 Product·복구 권한을 만들지 않습니다.

### 선택적인 Python 선언 조회

사용자는 작업을 한 번 요청하고, Lode가 JSON·digest·ID·파서·예산 선택을 사용자에게
요구하지 않고 조회 방법을 판단합니다. 일반 파일 읽기나 이미 최신인 World 범위
읽기로 충분하면 그대로 진행합니다. Python 파일이거나 선언 이름을 안다는 이유만으로
Context 작업 흐름을 추가하지 않습니다. 좁은 증거, 정확한 선언 경계, 과제별 Context
편입이 유용할 때 Lode가 selected-source를 선택할 수 있으며, 매번 벤치마크·이유서·
승인을 요구하지 않습니다. 선택했다면 아는 유일한 선언은 바로 읽고 목록은 선택
사항으로 둡니다. 이 작업 흐름 안의 `source`는 파일 텍스트를 Context에 넣는 기능으로,
작은 파일이나 전체 파일 문맥에 적합하지만 일반 파일 읽기와 같지는 않습니다.
목록과 선택을 두 번 요청하면 파일 한 번 읽기보다 비용이 커질 수 있습니다. World가
필요하면 구축 비용을 별도로 계산합니다. 일반 World 범위는 뒤의 줄을 포함할 수
있으며 Context Capsule을 만들지 않습니다. 출력 차이를 보편적 성능 우위로 해석하지
않습니다.

파서를 사용할 수 없거나 파싱 실패·증거 변경이 발생하면 Lode는 재조회하거나 일반
읽기를 계속할 수 있습니다. 이를 정확한 선언 경계나 Context 포함을 검증한 것처럼
표현하거나 오래된 선택 좌표를 재사용하지 않습니다. 독립 작업은 계속하고, 해소하지
못한 사용자 의도 모호성이나 기존 권한 경계만 질문합니다. 매번 내부 상태나 조회
방법 목록을 나열하기보다 결과와 의미 있는 한계를 설명합니다.

개발용 로컬 비교는
`node scripts/measure-python-declarations.mjs --output <new-absolute-directory>`로
실행합니다. 새 프로세스 3회의 최초·프로세스 내 반복 조회, 개별 값과 중앙값, 실제
dispatch 응답, 정확성 및 프로세스 기록을 남깁니다. 새 프로세스가 OS 캐시 초기화를
뜻하지는 않습니다. 고정 실행 순서와 계측도 지연에 영향을 주며, 프로세스 내부
dispatch 직렬화 크기는 stdio 전송량이나 설치 Host 비용이 아닙니다. 실제 provider
토큰·과금·프롬프트 캐시 절감은 미확인입니다. 이 측정은 선택 사항이지 사용·배포
관문이 아닙니다.

기존 `lode_source_context`에서 `declarations`는 제한된 정적 선언 목록을,
`selected-source`는 알려진 정규화된 선언 이름의 원문을 조회합니다. 원문 조회 전에
목록을 읽을 필요는 없습니다. CLI는 `--kind`로 선택하며, 단독 `--symbol`은 기존
호출 관계 조회 의미를 유지합니다. 동명 선언은 Lode가 응답의 정확한 선택 객체를
typed MCP 또는 고급 CLI `--input`에 전달합니다. 일반 대화에서는 Lode가 구조를
작성하며 사용자가 고급 API/CLI를 명시적으로 요청한 경우도 계속 지원합니다.

새 선언 Context 상세에는 비보존 상태에서도 작은 `collectionProfile`을 포함합니다.
생산자, Python 버전, 프로토콜과 구현 digest를 표시하며, 워커 identity를 이미
얻었다면 실패 응답에도 같은 요약을 제공합니다. 이는 시도한 파서를 설명할 뿐
파싱 성공이나 실행 시 진실성을 뜻하지 않습니다. 얻지 못한 identity를 꾸미지 않고,
전체 파일·원시 워커 응답·실행 파일 경로도 공개 응답에 추가하지 않습니다.
기존 v1 상세 형식은 그대로 유지합니다.

파서는 격리된 표준 라이브러리 AST/tokenize를 재사용하며 프로젝트 모듈을 실행하지
않습니다. 선택은 경로, digest, 선언 이름과 종류, 출현 번호, UTF-16 끝 제외 범위에
결합됩니다. 원문은 데코레이터와 내부 바이트를 보존하고 표시용 서명은 별도 축약
라벨입니다. 상한은 소스 1 MiB, 목록 64개, 표시 500자, 직렬화된 상세 60,000바이트이며
기존 Observation 필드의 65,536바이트 안에 머뭅니다. 선택 본문이 48,000바이트를
넘으면 조용히 자르지 않고 불가 상태를 명시합니다. JSON 이스케이프 때문에 상세
상한에 먼저 도달할 수도 있습니다. 이는 응답 크기 제한이지 의미적 자격 판정이나
목록 조회 의무가 아닙니다. 일반 소스·범위 읽기는 계속 사용할 수 있습니다.

증거 버전 1인 기존 `source.structural-context`는 바뀌지 않습니다.
새 `source.python-declaration-context`는 타입 버전 1, 증거 버전 2로 명시적으로
분기하며 기존 create-only 저장소를 재사용합니다. 과거 기록을 마이그레이션하거나
재해시하지 않습니다. 새 보존 증거도 Context 포함 전에 소스 변경을 검증합니다.
기본값은 비보존이며 이 선택적 읽기는 Canon, World, ReviewDecision 또는 복구
방향을 생성하지 않습니다.

Context compilation은 기본적으로 공통 observation을 제외합니다. Lode가 semantic analysis를 수행하고 kind가 `observation`이며 `observationIds`에 불변 현재 ID가 들어 있는 EvidenceNeed로 정확한 identity를 요청합니다. Core는 포함 증명 gate, lexical eligibility 규칙, semantic promotion 또는 sufficiency judgment 없이 선택 근거, 제외 정보와 불확실성을 보존합니다.

일상적인 inspection은 ephemeral하게 유지합니다. cross-Run, rebuttal/audit, handoff, context-loss evidence가 필요할 때만 Observation을 persist합니다. 사용자가 아니라 Host adapter가 정확한 source binding, descriptor, digest, coverage, provenance confirmation을 구성합니다. `observation-ingest`와 `lode_observation_ingest`는 이미 bounded된 input을 위한 고급 Host/CI surface입니다. 중복 collect 호환 별칭은 제거했습니다. `observation-source-collect`와 `lode_observation_collect_source`는 설정된 Host 소스에서 자료를 수집하는 별도 surface로 유지되며, 이미 bounded된 input을 수신하는 ingestion의 별칭이 아닙니다.

`observation-query`와 `lode_observation_query`는 전체 payload node 없이 전체 보존 자료의 개수·graph policy인 `inventorySummary`와 필터된 페이지를 함께 반환합니다. 별도 status 호출은 없습니다. `inventorySummary`는 필터된 match count가 아니며 빈 페이지가 보존 자료의 부재를 뜻하지 않습니다. 조회는 type, subject, source, time, observed/derived kind로 정확한 현재 identity를 필터링하며 최대 page는 100입니다. cursor continuation은 정확한 현재 `ObservationStatusProjection`에 binding되고 drift 시 fail closed합니다. query result에는 payload body 대신 payload digest가 들어갑니다. exact read surface는 선택한 record, descriptor, bounded receipt 또는 derivation lineage를 반환합니다. query는 discovery일 뿐 semantic selection, Context eligibility, sufficiency judgment가 아닙니다.

## 수락 속성

- 서로 다른 제품 domain이 Core의 domain vocabulary 없이 같은 계약을 사용합니다.
- 독립 source binding은 같은 upstream event key를 재사용할 수 있고, 하나의 정확한 binding 안에서 divergent replay는 fail closed합니다.
- 동시 identical writer는 수렴하고, 동시 divergent writer는 정확히 하나의 record와 일치하는 receipt 하나만 보존합니다.
- observation write는 Product Canon과 Session recovery byte를 변경하지 않습니다.
- Product Signal과 그 밖의 관련 없는 operating flow는 사용하지 않는 Observation storage를 load하거나 의존하지 않습니다.
- false completeness, schema drift, authority drift와 divergent replay는 fail closed됩니다.
- status와 query output은 bounded 상태를 유지하고 discovery를 semantic selection으로 바꾸지 않습니다.
- lexical overlap이 있어도 기본 Capsule compilation에는 common observation이 포함되지 않습니다.
- 정확한 Lode EvidenceNeed는 이름으로 지정한 immutable record만 포함합니다.
- derived record와 projection은 semantic graph relation을 추가할 수 없습니다.
- hypothesis는 정확한 observation을 참조해도 non-authoritative 상태를 유지합니다.
- CLI와 MCP는 같은 Core identity를 반환합니다.
- Host registry는 non-persisted P5 configuration으로 남고 검증된 result는 같은 P3 identity와 replay contract를 사용합니다.
- source registration은 bounded status projection 때문에 차단되지 않고 생략된 status entry가 명시됩니다.
- exact source filter와 opaque pagination으로 unbounded output 없이 모든 registered source를 discover할 수 있습니다.
- stale source cursor는 사용자에게 recovery ritual을 요구하지 않고 non-authoritative resynchronization을 명시하며 다시 시작합니다.
- source shape 및 availability summary는 bounded, non-semantic, non-instructional, non-persisted입니다.
- reuse-first preparation은 matching configured source보다 기존 exact Observation ID를 먼저 반환하며 sufficiency를 판단하거나 자동 collect하지 않습니다.
- 등록된 모든 source ID는 하나의 정확한 Lode Project에 binding되며 다른 Project로 collect할 수 없습니다.
- external adapter collection 전에 Project readiness를 검증합니다.
- conversational source flow는 opaque configured source ID만 받고 user에게 provenance structure를 요구하지 않습니다.
- reference event-file adapter는 Host path, raw event key, source alias 또는 credential reference를 persist하지 않으면서 서로 무관한 product schema를 받아들입니다.
- reference file path는 MCP 밖에 남고 malformed, oversized, relative-path 또는 divergent event는 fail closed합니다.
- 같은 metric key와 version은 두 개의 definition을 가질 수 없고, 새 explicit version은 계속 사용할 수 있습니다.
- adapter-revision 및 collection-condition difference를 공개하면서 numeric before/after comparison을 계속 사용할 수 있지만 semantic equivalence, normalization 또는 causality를 주장하지 않습니다. 기록된 모든 수집 조건이 같아도 Core는 `recordedCollectionConditionsEquivalent: true`만 보고하며 semantic equivalence는 `not-assessed`로 남습니다.
- metric assessment와 follow-up은 P3 evidence/candidate로 남고 Conformance, Product Canon 또는 P2 recovery를 변경하지 않습니다.
- delivery failure는 이전 applied 상태를 덮지 않고, rollback은 새 불변 event로 남으며, 충돌하는 순서는 unknown으로 유지됩니다.
- exact delivery revision binding은 persistence 전에 검증되어 P4에 연결되고 declared-only reference는 공개된 미연결 상태로 남습니다.
- delivery status는 bounded이며 unobserved target success 또는 deployment completeness를 추론할 수 없습니다.

> 이 문서는 [product-operating-loop.md](../product-operating-loop.md)의 한국어판입니다. 코드, 명령, 프로토콜 식별자와 필드 이름은 원문 표기를 유지합니다.

# Product Operating Loop

상태: Product Operating Loop 프로토콜 `0.4.0`에 따른 최소 수직 경로가 구현되어 있으며, 다이제스트를 읽을 수 있는 `0.1.0`, `0.2.0` 및 `0.3.0` 호환성을 제공합니다.

Product Operating Loop는 관찰, 모델 추론, GraphDB 또는 연속성 요약을 Lode나 사용자의 권한으로 만들지 않으면서 제품 학습을 검토된 실행과 연결합니다.

## 중립적인 근거 참조

새 ProductHypothesis 아티팩트만 프로토콜 0.5.0과 필수 referenceSemantics 값
neutral을 사용합니다. Signal과 Observation 연결은 REFERENCES이며, 모든 인용이
가설을 지지한다는 기계적 판정이 아닙니다. 지지·반박·불확실성은 Lode가 기존
rationale에 설명하며 별도 근거 역할 입력 양식은 없습니다. 나머지 운영 아티팩트는
0.4.0을 유지합니다. 과거 가설의 바이트·해시·SUPPORTED_BY 해석은 그대로 보존되고
새 reader가 마이그레이션 없이 읽습니다. 옛 reader는 새 가설 버전을 거부하므로
옛 의미를 조용히 적용하지 않습니다. 새 아티팩트를 소비하는 작업에서 혼합 버전
읽기·쓰기는 지원하지 않으며 독립적인 일반 작업에는 영향이 없습니다.
측정 이력 조회는 두 관계를 모두 따라갑니다.

## 개발 척추와 운영 흐름

구현은 경쟁하는 두 권위를 만들지 않으면서 두 가지 의미 방향을 유지합니다. 개발 척추는 `Product Canon`과 명시적 `ReviewDecision` record에서 검토된 제품-코드 관계로 이어지는 하향식 규범 경로입니다. 운영 흐름은 initiative 검토, 실행, `ChangeSet`, `OutcomeObservation`을 지나는 시간 순서 evidence 경로입니다. 두 경로의 교차점은 P4 graph의 정확히 검증된 identity 또는 relation이며, 권위 record의 복사본이 아닙니다. 코드나 runtime 관찰은 P3 evidence와 candidate를 만들 수 있지만 개발 척추를 다시 쓸 수 없습니다.

이제 provider-neutral `BranchStateObservation`, `DeploymentResultObservation`, `ReleaseObservation` ingestion이 bounded P3 evidence로 운영 흐름을 확장합니다. 그 존재나 시각은 제품 승인, Product Canon, 성공 판정 또는 복구 방향을 만들 수 없습니다. `AnalyticsEvent` ingestion은 추론하거나 모사한 loop closure가 아니라 명시된 capability gap으로 남습니다. [Release observation](release-observation.md)을 참고하세요.

## 권한 분리

루프는 다섯 가지 인식론적 클래스를 사용합니다.

| 클래스 | 아티팩트 | 권한 효과 |
| --- | --- | --- |
| 관찰된 사실 | `ProductSignal` | 증거일 뿐 |
| 가설 | `ProductHypothesis` | 결정 권한 없음 |
| 추론된 의미 | `ProductInitiativeCandidate`, `ProductFeatureCandidate` | 후보일 뿐 |
| 승인된 결정 | `ReviewedProductInitiative` | 명시적으로 검토된 이니셔티브이며 Product Canon은 아님 |
| 파생 프로젝션 | Product Graph 및 `LodeContinuitySnapshot` | 재구축 가능한 참조 뷰일 뿐 |

`ProductSignal → ProductHypothesis → ProductInitiativeCandidate`는 추론의 궤적이지 권한 체인이나 필수 영속화 체인이 아닙니다. 일상적인 관찰·가설·추론은 근거와 함께 대화에 남깁니다. 형식화 API·콘텐츠 식별자·그래프 재구축은 필요하지 않습니다. Signal/Hypothesis 아티팩트는 Run 간 경계, 반박/감사 경계, 제품 상태 경계 또는 인계/컨텍스트 손실 경계에서만 영속화합니다. Product Initiative는 `decisionScope: product-initiative`인 명시적 `ReviewDecision`을 통해서만 검토된 상태가 됩니다. Product Canon은 `.lode/context/product-model.json`에 그대로 있으며 이 흐름에 의해 변경되지 않습니다.

이제 durable `ProductHypothesis`는 별도로 persisted `ProductSignal`이 있거나 없어도 `observationIds`를 통해 정확한 `ObservationRecord` 또는 `DerivedObservationRecord` identity를 인용할 수 있습니다. 이미 검증된 evidence를 사람이 다시 작성할 필요를 없애지만 adapter가 meaning을 작성하지는 않습니다. hypothesis는 여전히 Lode가 작성하며 reference는 review, promotion, success 또는 recovery authority를 부여하지 않습니다.

Observation storage는 optional이며 격리된 상태를 유지합니다. Product Operating projection과 signal-only flow는 durable hypothesis가 정확한 Observation ID를 실제로 참조하지 않는 한 이를 load하거나 validate하지 않습니다. 일단 참조되면 현재 Observation integrity와 receipt lineage는 이전과 같이 fail closed합니다.

## 연결된 최소 흐름

```text
ProductSignal (observed-fact)
  -> ProductHypothesis (hypothesis)
  -> ProductInitiativeCandidate (inferred-meaning)
  -> explicit user ReviewDecision
  -> ReviewedProductInitiative (approved-decision, not Product Canon)

Feature resolution:
  existing-feature -> exact current Product Canon Feature key
  candidate        -> separate ProductFeatureCandidate
  gap              -> explicit reason; no forced one-to-one mapping

accepted execution ReviewDecision + ResultPacket -> ChangeSet
  -> OutcomeObservation (observed-fact or derived-projection)
  -> Lode reevaluates product meaning and success
```

영속 Signal/Hypothesis 경로는 명시적 감사 경계를 위해 계속 사용할 수 있습니다. 더 가벼운 경로는 명시적인 인라인 추론에서 불변 `ProductInitiativeCandidate`를 직접 생성할 수 있습니다. 이 경로는 Feature 결정을 수락 검토까지 미룰 수 있으므로 사용자 결정 전에는 `ProductFeatureCandidate`가 존재하지 않습니다. 검토된 Initiative는 후보의 바이트에 의존하지 않고 제목, 설명, 추론 및 가설 참조를 보존하면서, 별도의 검토 아티팩트에 정확히 하나의 `existing-feature | candidate | gap` 결정을 추가합니다.

현재 Initiative `ReviewDecision`은 exact candidate와 Feature selection을 한 번만 기록합니다. reviewed initiative와 Feature candidate는 중복 결정을 저장하지 않고 그 기록에서 읽기 전용으로 재구성합니다. project-local P5 writer lease가 경쟁 발행을 직렬화하며 exact retry는 추가 쓰기 없이 decision을 재사용합니다. 과거 원본 output은 계속 읽을 수 있고, 누락된 deferred legacy selection은 추측하지 않습니다.

이는 mutation-integrity 검사이지 추가 사용자 gate가 아닙니다. 기존 explicit review만 유일한 authority boundary로 유지되고, 일반 read와 작업은 계속 가능하며, 일시적 writer contention은 Product Canon이나 P2 recovery direction을 바꾸지 않고 내부에서 처리됩니다.

`OutcomeObservation`은 해당 `ResultPacket`에 수락된 실행 `ReviewDecision`이 있는 ChangeSet을 참조해야 합니다. 또한 검토된 Initiative를 참조할 수 있습니다. Feature의 성공을 표시하거나, Feature 상태를 변경하거나, Product Canon을 승격할 수는 없습니다.

## Product Graph 경계

World Model은 아티팩트를 `ProductSignal`, `ProductHypothesis`, `ProductInitiativeCandidate`, `ProductInitiativeReviewDecision`, `ReviewedProductInitiative`, `ProductFeatureCandidate` 및 `OutcomeObservation` 노드로 프로젝션합니다. `SUPPORTED_BY`, `PROPOSES_FROM`, `PROPOSES_TO`, 검토/승격 관계 및 `OBSERVES`를 통해 이 경로를 질의할 수 있습니다.

이 그래프는 `derived-evidence-only`입니다. 로컬 JSON이면 충분합니다. GraphDB는 선택적 구체화이며 오케스트레이션, 도구 라우팅, 컨텍스트 선택, ReviewDecision 또는 제품 의미를 소유할 수 없습니다.

### 저장된 원본과 미완료 파생 갱신

primary 원본이나 검토가 검증·저장된 뒤 World/Product Graph 갱신이 실패해도 정확한
ID를 숨기거나 저장 자체의 실패로 바꾸지 않습니다. 기존 응답의 primary 상태와
identity는 유지합니다. 이 예외에만 `productGraph.status: "deferred"`, 제한된
`reasonCode`, `ordinaryWorkBlocked: false`를 반환하고 정상 graph의 세 identity
필드는 그대로입니다. Initiative 검토의 text에도 저장된 결정과 파생 갱신 미완료를
함께 표시합니다.

deferred는 파생 갱신이 완료되지 않았다는 뜻이지 재시도 예약이나 파생 쓰기 0의
보장이 아닙니다. queue·강제 refresh·효과 자동 재실행·추가 사용자 절차는 없습니다.
입력·참조·권한·digest 오류, 불확실한 primary 발행과 부분 primary 저장 실패는
계속 실패하며 손상 원본은 보존합니다. 정확한 재시도는 검증된 원본을 재사용하고
결정을 중복 생성하거나 실행 권한을 늘리지 않습니다.

## Lode 연속성 경계

`LodeContinuitySnapshot`은 요청 시 빌드되며 프로젝트 저장소에 절대 기록되지 않습니다. 현재 Project, Session, Run, WholePlan, ExecutionContract, ResultPacket, ReviewDecision, checkpoint, Product Model, World Model 및 product-operating 식별자가 존재할 경우 그에 대한 정확한 참조를 포함합니다.

이 스냅샷은 다음과 같은 고정 속성을 모두 갖습니다.

- `persisted: false`
- `recoveryAuthority: false`
- `instructionAuthority: false`
- `promotionAuthority: false`
- `objectiveRewrite: false`

복구 권한은 `.lode/sessions/current.json`, Run 정본 및 Session/Run checkpoints에 계속 있습니다. 이 스냅샷은 Lode의 지속적인 전체 결과 판단을 대체할 수 없습니다.

동일 프로세스에서 반복되는 `product-operating-status` 및 `head-continuity` 읽기는 Product Operating 프로젝션 식별자와 World Model 콘텐츠 식별자를 키로 하는, 공개되고 검증된 스냅샷 캐시를 사용합니다. Core 쓰기는 캐시를 무효화합니다. 전체 아티팩트 및 World Model 검증을 강제하려면 `--fresh` 또는 MCP `fresh: true`를 사용합니다. 캐시 상태는 운영 정보일 뿐이며 권한이나 복구 증거가 될 수 없습니다.

## CLI

`lode-agent help`는 Core 작업과 복구를 보여 줍니다. 위험은 Lode가 직접 판단하고,
임시 사실·가설·추론과 근거는 대화에서 구분합니다. 영속 Signal/Hypothesis,
감사나 복구가 필요할 때 `lode-agent help-all`로 찾습니다. 실행 수단과 임시 학습은
Lode가 직접 판단하고 표현하며 Core 분류기나 메모 형식화 호출은 없습니다.

```text
lode-agent product-signal-record <project> --input <signal.json>
lode-agent product-hypothesis-record <project> --input <hypothesis.json>
lode-agent product-initiative-propose <project> --input <initiative.json>
lode-agent product-initiative-review <project> --input <review.json>
lode-agent product-outcome-observe <project> --input <outcome.json>
lode-agent product-operating-status <project> [--fresh]
lode-agent head-continuity <project> [--fresh]
```

record/review/observe 명령은 primary 저장 뒤 같은 작업에서 로컬 World Model과 Product Graph 재구축을 시도합니다. 파생 갱신 미완료는 저장 성공과 별도로 표시하며 원격 GraphDB를 활성화하지는 않습니다.

## MCP

Lode 직접 작업이 기본이고, 유용하면 일반 Host 위임을 사용합니다.
실제 복구·효과 추적이 필요할 때만 관리형 실행을 선택하며 워커 수를 위험 점수로
쓰지 않습니다. 보호 전이는 lane 권고를 신뢰하지 않고 기존 권한 검사를 수행합니다.

선택적인 typed MCP 목록에는 다음 도구가 있습니다.

- `lode_product_signal_record`
- `lode_product_hypothesis_record`
- `lode_product_initiative_propose`
- `lode_product_initiative_review`
- `lode_product_outcome_observe`
- `lode_product_operating_status`
- `lode_continuity_snapshot`

기본 MCP 목록은 독립 Session 생성과 현재 공통 방향 갱신을 포함한 Core·복구에
집중합니다. 이미 제공된 typed 도구는 정상적인 최초 사용에서 직접 호출합니다.
필요한 선택적 스키마는 `lode_tools_discover`의 정확한 이름이나 반환된 prefix로
찾습니다. 호환되는 `invokeWith`는 여전히 `lode_tools_read` 또는
`lode_tools_call`이며, `{name, arguments}` 안에 기존 원래 스키마의 인자를 전달합니다.
상태를 저장하지 않는 이 경로는 기존 dispatch·검사·결과를 유지하며 등록·활성화나
새 내부 승인 게이트를 추가하지 않습니다. 읽기 전용 경로는 별도로 유지하고,
이미 아는 선택적 계약은 사전 탐색 없이 기존 router로 호출할 수 있습니다.
정상 최초 사용은 거부된 효과를 다른 경로로 수행할 권한이 아닙니다. 지속 작업에 유용한
관리형 변경은 `lode_tools_call`의 `execution_mode: "managed"`를 사용하고
사용자 unlock 없이 원래 검사를 유지합니다.

Session 생성은 기존 canonical 원본을 덮어쓰지 않고 추가하거나 재사용합니다.
재생성 가능한 그래프 inventory와 임시 lock은 바뀔 수 있습니다. 공통 방향·체크포인트
갱신은 현재 제약·취소나 Session 복구 방향을 대체할 수 있어 파괴적 가능성 표시가
true입니다. 기존 Host 정책이 승인을 요구하거나 `never`에서 해당 저장을 거부할 수
있으며, 도구 노출이 면제를 뜻하지는 않습니다. 보존하지 못한 내용과 복구 영향만
알리고 독립적으로 허용된 작업은 계속합니다. 기록 거부가 완료된 코드를 무효로 하거나
그 효과를 재실행할 권한을 만들지는 않습니다.

Initiative 검토에는 `confirm_user_review: true`가 필요합니다. 이 확인은 사용자가 소유한 검토 권한을 기록합니다. MCP를 사용할 수 있다는 사실만으로 그 권한이 부여되지는 않습니다.

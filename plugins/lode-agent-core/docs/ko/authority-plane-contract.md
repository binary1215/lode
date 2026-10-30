> 이 문서는 [authority-plane-contract.md](../authority-plane-contract.md)의 한국어판입니다. 코드, 명령, 프로토콜 식별자와 필드 이름은 원문 표기를 유지합니다.

# 권한 평면과 그래프/레코드 경계

이 계약을 변경하기 전에 [`architecture.md`](architecture.md)를 읽으세요. 런타임 방향은 저장소 개발 이력이나 검증 fixture가 아니라 사용자가 소유한 프로젝트 권한에서 나옵니다.

상태: 활성 실행 가능 계약

프로토콜 버전: `0.9.0`

다이제스트가 유효한 `0.1.0`, `0.2.0`, `0.3.0`, `0.4.0`, `0.5.0`, `0.6.0`, `0.7.0`, `0.8.0` 내장 경계는 업그레이드 연속성을 위해 계속 읽을 수 있으며, 새 builder는 `0.9.0`을 내보냅니다. reader가 유지하는 유일한 레거시 분류는 과거의 일반 Feature/Policy 명명이며, 새 artifact를 승격하는 데는 절대 사용되지 않습니다.

`WorkerPatchIntegrationIntent`는 P3입니다. Lode가 선택한 조합의 정확한 dispatch,
authorization, 종료된 receipt, owner가 동결한 patch 출처를 연결합니다. 경로를
예약하거나 파일을 적용하거나 새 실행을 승인하거나 Run을 완료하거나 복구 방향을
작성하지 않습니다. 소스·Session이 변경되고 Host 임시 파일이 없어져도 과거 증거는
읽을 수 있습니다. 현재 실행·파일 효과 검사는 과거 증거 조회와 별개입니다.

적용 단계의 `WorkerIntegrationEffectClaim`, `WorkerIntegrationEffectAttempt`,
`WorkerIntegrationEffectReceipt`는 P3입니다. 정확한 파일 효과가 시작됐을 수
있다는 제한된 증거이며 새 실행 승인이 아닙니다. 실제 효과 경로의 미완료 상태는
Run·Session을 넘어 확인하지만 읽기 의존성이나 변경하지 않은 소유 경로는 예약하지
않습니다. P3 `WorkerIntegrationIncompleteSettlement`는 효과 소유자가 더 이상
쓸 수 없음이 확인된 뒤 명시적으로 미완료를 인계합니다. 불명확한 시도를 성공으로
고치거나 재실행을 승인하지 않습니다. native journal·프로세스 식별자·실시간 소유권은
P5에 남습니다.

`WorkerIntegrationVerification`은 현재 통합 상태에 대한 Lode의 판단을 동결합니다.
`WorkerIntegrationResultApplication`은 하나의 전체 ResultPacket을 기존 Run 완료와
Fresh Lode 검토에 연결합니다. 둘 다 P3이며 ReviewDecision이나 P2 checkpoint 통합을
생성하지 않습니다. 근거가 바뀌면 Lode가 다시 판단하지만 사용자 승인 절차를 추가하거나
소스를 영구적으로 잠그지는 않습니다.

## 이 경계가 존재하는 이유

Lode Agent Core는 한 표현이 다른 표현의 권한을 물려받게 하지 않으면서 의미, 복구, 증거, 파생 검색, 실시간 효과를 조정합니다. 아래 다섯 평면은 의미 artifact를 분류합니다. `Distribution`과 `Host`는 별도의 아키텍처 평면입니다. 이들은 이러한 계약을 패키징하거나 실행하지만 제품 의미나 복구 방향의 추가 출처가 되지는 않습니다.

| 평면 | 소유 범위 | 대표 artifact | 금지된 추론 |
|---|---|---|---|
| P1 Normative Authority | 승인된 제품 의미, 정책, 명시적 결정 | Product Canon, ProductModelRevision, ProductCanonFeature/ReviewedFeature, PolicyCanon/ReviewedPolicy, ReviewDecision, accepted ProductPolicyReviewDecision | 그래프, 메시지, 결과 또는 host에 존재한다는 사실만으로 승인을 만들 수 없음 |
| P2 Canonical Recovery/Lineage Record | Project, Session, Run, 계획, context, contract와 다음 방향의 provider 독립적 복구 | Project, ProjectDirection, LodeSession, Run, WholePlanSnapshot, ContextCapsule, ExecutionContract, SessionRunCheckpoint | 증거 삭제나 provider 요약이 checkpoint 필드를 다시 쓸 수 없음 |
| P3 Evidence Record | 검토 가능한 결과, 관찰, 후보, claim, 소유권 레코드와 감사 receipt | ResultPacket, WorkerReport, BoundedWorkerDispatch, BoundedWorkerWave/Seal/Abandonment, CandidateSet, FeatureCandidate/ProductFeatureCandidate, PolicyCandidate/ProductPolicyCandidate, Evidence, ObservationTypeDescriptor/ObservationRecord/DerivedObservationRecord/ObservationCollectionReceipt, MetricDefinitionProjection, ProductHypothesis, ConformanceFindingCandidate/DispositionReceipt/ResolutionCandidate, BranchStateObservation, DeploymentResultObservation, ReleaseObservation, DocumentCanonApplicationReceipt, RunResultIntegrationRequest/Receipt | 증거가 스스로 승격되거나 복구 Canon이 될 수 없음 |
| P4 Derived Relation/View | 재현 가능한 검색과 사람 대상 view | ProjectGraphDiscoveryProjection, ProjectGraphObservationIndex, GraphSnapshot, GraphDB projection, TraversalResult, GraphLineageStatusProjection/TraceProjection/DiffProjection, MeasurementLineageProjection, DeliveryStateProjection, Markdown/Document projection, LodeContinuitySnapshot, SessionRestoreProjection, RecoveryCheckpointDiagnosisProjection, WorkerWaveStatusProjection/ResultProjection, ObservationStatusProjection, ObservationSourceDiscoveryProjection, ObservationPreparationProjection, ConformancePreparationProjection/QueueProjection/FindingGraphProjection/TriggerBatchProjection | projection이 Canon을 변경하거나 지시 권한을 부여하거나 유일한 복구 출처가 될 수 없음 |
| P5 Operational Effect | host 로컬 process, continuation, wait와 delivery 효과 | PID, token, proof, lease, endpoint, inbox, delivery receipt, ContinuationOutcome, BoundedWorkerWaitOutcome, BoundedWorkerWaveWaitOutcome, ObservationSourceBinding, ConformanceTriggerBinding, provider-session reference | continuation, wait, delivery 또는 process 제어의 성공이 실행, 검토, 승격 또는 복구를 승인할 수 없음 |

`scripts/lib/authority-plane-contract.mjs`는 내용에서 파생된 하나의 `AuthorityPlaneContract`를 내보내고, 위에서 구현된 artifact를 정확한 평면에 할당하며, 내장된 artifact 경계를 검증합니다. 이 평면들은 지속성 계층이 아니라 의미 클래스입니다. P2는 복구에 대한 권한을 갖지만 P1의 제품 의미를 소유하지 않으며, P1 검토는 P2 checkpoint 상태를 대체하지 않습니다.

경계 객체의 false 지시/승격 flag는 분류만으로는 어떤 행동 권한도 부여되지 않음을 뜻합니다. 특정 P1 ReviewDecision은 정확하고 다이제스트에 결속된 범위 한정 승인을 별도로 담을 수 있습니다. 다른 평면은 그 결정을 참조하거나 저장했다는 이유만으로 그 승인을 얻지 못합니다.

## 비증폭

승인 경계는 로컬 호출자가 실제 사용자 결정을 전달한다고 신뢰합니다.
Core는 정확한 대상, 처분, digest와 허용된 전이를 검증하지만, 요청이 사용자를
지칭하거나 확인 플래그를 설정했다는 이유로 사람의 의사를 인증하지는 않습니다.
Host와 provider Lode는 보호된 변경을 호출하기 전에 현재 사용자 결정을
변경되지 않은 후보에 연결해야 합니다. 도구 annotation은 효과를 설명할 뿐
승인이 아닙니다. 더 강한 인증이 필요한 Host는 Core 호출 전에 자체 사용자 행동
영수증을 검증할 수 있으며, 영수증과 provider identity는 Host 경계에 남습니다.
일반 작업에 추가 승인 절차가 생기지는 않습니다.

한 평면이 다른 평면을 가리킨다는 이유만으로 권한이 위로 이동할 수 없습니다. P3 후보는 명시적으로 검증된 ReviewDecision과 정확히 검토된 변경 작업을 통해서만 P1에 영향을 줄 수 있습니다. World/Graph는 snapshot이 소비한 정확한 Product Canon 바이트를 기준으로 고정합니다. immutable 준비는 짧은 `session-recovery` commit scope 밖에서 수행합니다. current pointer 게시 전에 그 scope에서 Project/storage identity·Canon 기준·예상 current World pointer를 재검증합니다. 기준이 달라지면 `WORLD_MODEL_CANON_BASIS_CONFLICT`로 실패하고 현재 Canon을 보존합니다. 바이트 차이만으로 작성자를 단정하거나 이전 Canon을 덮어써 복원하지 않습니다. 권한·identity·I/O 오류는 원래 코드를 유지합니다. 명시적으로 금지된 권한 API는 계속 증폭을 거부합니다. 이는 Core 간 협력적 직렬화이며 OS sandbox 또는 여러 pointer의 crash atomicity를 보장하지 않습니다.

후보 제품 개념과 검토된 제품 개념은 이름과 평면이 서로 다릅니다. 그래프 node가 일반 또는 미검토 Feature/Policy label을 사용한다는 이유만으로 해당 개념이 P1로 분류되는 일은 없습니다. Product Canon 또는 별도로 검토된 Feature/Policy만 P1이며, FeatureCandidate, ProductFeatureCandidate, PolicyCandidate는 P3에 남습니다.

accepted Product Policy ReviewDecision은 정확히 candidate에 결속된 Product Canon revision만 변경합니다. 그 P4 graph copy, Observation comparison, metric assessment 및 follow-up candidate는 해당 authority를 반복하거나 넓힐 수 없습니다. Measurement collection condition의 difference와 unknown은 silent equivalence claim이나 새 blocking gate가 아니라 disclosure된 evidence로 남습니다.

P3 증거, P4 파생 view, P5 운영 효과는 어떤 경우에도 P2 복구 권한으로 승격될 수 없습니다. checkpoint가 감사를 위해 증거를 참조할 수는 있지만, 그 복구 필드는 명시적인 Lode/사용자 방향과 검증된 P2 lineage에서만 옵니다. ResultPacket, GraphSnapshot, continuity, inbox 또는 provider-session 상태는 그 필드를 제공하거나 다시 쓸 수 없습니다.

context와 조정에도 같은 규칙이 적용됩니다.

- provider Lode semantic product proposal은 P3 evidence입니다. Core는 이를 검증하고
  immutable candidate set으로 정규화할 수 있지만 Product Canon이나 ReviewDecision을
  생성할 수 없습니다.
- Capsule은 지시 및 승격 권한이 false인 제한된 그래프 순회만 포함할 수 있습니다.
- 지속되지 않는 ContextWorkflowProjection은 P4 selection 안내입니다. 출처·누락·불확실성을 제공하며 고정 tier나 포함 증명 gate는 없습니다. Lode가 충분성과 유용한 확대를 판단합니다. 의미 선택, provider 호출, 상태 변경, 승인 또는 복구 방향 쓰기는 할 수 없습니다.
- 지속되지 않는 ContextPreparationProjection은 의미 추론이 아니라 P4 candidate visibility입니다. task text만 받아 제한된 현재 identity와 lexical discovery material을 보여주고 provider Lode가 사용자 JSON 없이 구조화 proposal을 작성하게 합니다. EvidenceNeeds나 graph anchor를 선택하거나 provider/session identity를 영속화하거나 P2 방향을 쓸 수 없습니다. 이후 preview는 Project/World/Graph drift를 다시 검증합니다.
- 검토 전 후보는 Canon context compilation에서 제외됩니다. 일반 탐색은 원래 후보·거절 상태를 표시한 P3 자료를 포함할 수 있지만 관계 확장에서도 승격하지 않습니다.
- provider 요약, continuity view, inbox message와 reply는 checkpoint 필드를 변경하거나 ReviewDecision을 만들 수 없습니다.
- 원격 GraphDB는 검증된 query를 가속할 수 있지만, 로컬 규범 레코드와 복구 레코드가 손실된 뒤 Product Canon을 재구성할 수는 없습니다.

공통 observation도 같은 분리를 보존합니다. `ObservationTypeDescriptor`, `ObservationRecord`, `DerivedObservationRecord`, `ObservationCollectionReceipt`는 P3 evidence artifact이고, `ObservationStatusProjection`, `ObservationSourceDiscoveryProjection`, `ObservationPreparationProjection`은 P4이며, `ObservationSourceBinding`은 P5입니다. descriptor 등록, collection, derivation, source discovery, reuse-first preparation, exact-ID Capsule inclusion 또는 hypothesis reference는 P1 meaning이나 P2 direction을 만들 수 없습니다. [`observation-adapters.md`](observation-adapters.md)를 참고하세요.

Delivery state도 새 authority plane 없이 같은 분리를 유지합니다. `delivery.state` `ObservationRecord`는 P3이고, current/history `DeliveryStateProjection`과 검증된 exact `AT_REVISION` relation은 P4입니다. 명시적 순서 충돌은 일반 작업이 아니라 해당 current-state derivation만 `unknown`으로 만듭니다. 실패 시도는 이전 applied evidence를 지울 수 없고, 관측되지 않은 target은 성공으로 추론할 수 없습니다. [`delivery-observation.md`](delivery-observation.md)를 참고하세요.

Conformance 재정도 같은 분리를 보존합니다. Finding 및 resolution candidate와 exact-Finding disposition receipt는 P3이고, preparation, queue, audit graph, trigger-batch projection은 P4이며, 선택적 process-local trigger binding은 P5입니다. Graph 부재, partial coverage, advisory risk, 선택적 adapter 손실, 열린 Finding, queue 길이는 일반 작업을 막을 수 없습니다. 교차 Project 증거, tampering, stale mutation input, path escape, divergent replay 또는 authority amplification만 영향받는 동작을 실패시킵니다. 코드 수정 요청에는 여전히 일반 execution lane이 필요하고 Canon 개정 요청에는 기존 exact 사용자 `ReviewDecision`이 필요합니다. [`conformance-reconciliation.md`](conformance-reconciliation.md)를 참고하세요.

Product Initiative review는 exact candidate와 Feature selection을 담은 scoped decision 하나를 기록합니다. reviewed initiative와 FeatureCandidate output은 decision의 읽기 전용 재구성이며 중복 저장 승인이 아닙니다. 기존 P5 writer lease가 경쟁 결정을 직렬화합니다. exact retry는 decision을 재사용하고 legacy의 누락된 deferred selection은 추측하지 않습니다.

## 그래프와 레코드의 차이

제품의 의미 Canon은 P1에 남습니다. Core의 시간적 `GraphSnapshot`은 P4입니다. 이는 검증된 Canon과 레코드 위에 구축된, 내용에서 파생되고 재구축 가능한 관계 및 검색 index입니다. `productModelId`와 hash는 projection의 출처를 결속할 뿐, Product Canon 권한을 그래프로 이전하지 않습니다. GraphDB는 그 정확한 snapshot을 대체 가능하게 구체화한 것일 뿐입니다. GraphDB와 생성된 Markdown을 삭제해도 Product Canon, Session/Run 복구, ReviewDecision lineage가 온전해야 합니다.

이 구분은 두 제품을 혼동하지 않으면서 원래 Product Graph의 통찰을 보존합니다. 제품 지식 model은 의미 Canon을 담을 수 있지만, Lode Core의 시간적 그래프는 Canon과 실행 레코드 위에 구축된 파생 index입니다. 전자만 의미를 소유하고, 후자는 탐색을 담당합니다.

## 결과와 checkpoint 경계

`ResultPacket`과 `WorkerReport`는 P3 증거입니다. P2 `SessionRunCheckpoint`에 이미 고정된 정확한 `nextExpectedResult`를 변경하지 않고도 이를 검토하거나 첨부하거나 삭제할 수 있습니다. `ReviewDecision`은 P1 규범 레코드이고, checkpoint는 복구 레코드입니다. 어느 것도 다른 하나를 대신하지 않습니다.

수락된 검토 결과는 명시적 integration으로 복구에 연결됩니다.
Lode가 방향을 제공하며 검증된 ResultPacket과 ReviewDecision은 참조이지 필드 작성자가 아닙니다.
lock 안의 checkpoint 발행 한 번이 exact reviewed Run과 정규화한 방향을 결속합니다.
동일 재시도는 재사용하고 다른 방향은 충돌하며, 중단 시 누락된 Session pointer 갱신만
재개합니다. 별도의 integration request나 receipt는 새로 만들지 않습니다.
과거 기록은 좁은 원본 형식 reader로 계속 읽습니다. artifact-only restore는
증거 receipt의 생존 여부가 아닌 자체 완결적인 P2 방향을 사용합니다.

비지속 recovery checkpoint basis는 P4 비증폭 규칙을 따릅니다. Core가 오래됐거나 이미
수렴한 게시 요청을 구분할 수 있도록 정확한 현재 P2 identity와 전이 상태만 결속합니다.
자연어 복구 방향은 계속 provider Lode만 도출하며, 해당 basis를 읽은 뒤 도출해야 합니다.
basis의 존재, 바뀐 basis ID, Run result, open epoch 또는 운영 Host event는 checkpoint
field의 출처가 될 수 없습니다. lock을 사용하는 sync는 명시적인 Lode 방향으로 P2
checkpoint 하나를 만들거나, 정확한 현재 byte를 재사용하거나, 미완료 전이를 연기하거나,
오래된 상태를 거부할 수 있을 뿐입니다.

선택적 live continuation도 같은 경계를 따릅니다. Core가 먼저 정확한 P2 checkpoint를 복원한 뒤, P5 WorkspaceHost adapter가 이미 실행 중인 endpoint 하나를 fresh-verify할 수 있습니다. 지속되지 않는 `ContinuationOutcome`은 `attached` 또는 공개된 새 논리 Lode fallback을 보고합니다. 이는 SessionRestoreProjection을 변경하거나, provider identity를 지속하거나, 복구 권한을 주장할 수 없습니다.

`RecoveryCheckpointDiagnosisProjection`도 P4입니다. 제한된
`basis B0 -> restore -> basis B1` 순서를 검증하고 현재 pointer, artifact 복구와 기계적인
sync 가능 여부에 관한 사실을 보고합니다. basis를 cache하거나 mutation lock을 획득하거나,
증거를 repair하거나, provider Lode를 호출하거나, 의미적 최신성을 판단하거나, checkpoint
field를 제공할 수 없습니다. 순차 관찰의 일치는 원자적 filesystem snapshot이 아니며 ABA를
감지할 수 없습니다. 관찰이 바뀌면 새로 읽어야 하고 integrity 실패와 필수 artifact 누락은
선택적 증거 누락으로 다시 표시되지 않습니다.

독립적으로 소유 가능한 worker 실행은 정확한 Session 또는 Run `ExecutionAuthorization` 위에 하나의 P3 `BoundedWorkerDispatch`를 기록합니다. Session 결과는 wait/result 조회를 통해 Lode가 증거로 소비하며, Run 적용이나 필수 영속 Capsule, P1/P2 진행을 요구하지 않습니다. P5 lease/process/wait는 at-most-once 사용을 강제하지만 WholePlan을 바꾸거나 ReviewDecision을 만들 수 없습니다. Run 결과는 기존 P3 ResultPacket → Fresh Lode → 명시적 P1 검토 → reviewed-result integration을 유지합니다. Wave와 worker-apply는 Run 전용입니다.

`BoundedWorkerWave`는 정확한 Project, Lode Session, active Run, WholePlan, ExecutionContract, Capsule lineage가 모두 동일할 때만 여러 dispatch를 묶을 수 있습니다. 이는 어떤 승인도 부여하지 않으며 각 lease는 독립적으로 유지됩니다. P3 seal에는 모든 member에 대한 검증된 소비가 필요하고, P4 status는 그 seal을 만들 수 없습니다. Wave의 실패, 완료, abandonment, result projection과 P5 wait는 P1 review나 P2 recovery direction을 만들 수 없습니다.

실행 가능한 복구 test는 ResultPacket을 만들고 checkpoint를 준비한 다음 ResultPacket 파일을 삭제하고도 checkpoint가 정확한 다음 예상 결과를 계속 재현하는지 검증합니다. 이는 증거/복구 경계에 대한 삭제 test이지, 정상 운영에서 증거를 폐기해도 된다는 허가가 아닙니다.

## 인과적 projection과 자기 참조 금지

문서 적용은 검증된 검토 해시와 적용 전 World 식별자만 연결하는 좁은 P3 Evidence basis를 보존할 수 있습니다. 승인이나 문서 본문을 복제하지 않고 P2 필드를 제공하지 않으며, 이 기록만으로 변경 권한이 생기지 않습니다. 동일한 수락 또는 거부 결정으로 기존 변경 전·목표 아티팩트를 이용해 파생 게시를 재개합니다. 프로젝션 실패는 이미 반영한 승인 Canon을 지우거나 후속 사용자 편집을 덮어쓸 권한을 주지 않습니다.

receipt는 자신이 이름으로 지정한 GraphSnapshot의 일부일 수 없습니다. 따라서 Document Canon application은 다음과 같은 인과 순서를 사용합니다.

```text
verified ReviewDecision
  -> exact reviewed Product Canon mutation
  -> named child World Model / GraphSnapshot
  -> immutable application receipt naming that snapshot
  -> later audit child GraphSnapshot that may project the receipt
```

Core는 양쪽을 모두 검증합니다. 이름으로 지정된 그래프에는 새 receipt가 없고, 후속 그래프는 다른 identity를 가지며 이전 SourceSnapshot을 parent로 지정하고 receipt를 포함해야 합니다. 같은 snapshot에 포함하면 `GRAPH_SNAPSHOT_RECEIPT_SELF_REFERENCE`로 실패합니다.

## 실행 가능한 수락 기준

- 현재의 모든 lineage, checkpoint, GraphSnapshot과 application-receipt builder는 자신의 정확한 평면 경계를 내보내고, 현재 reader는 이를 검증합니다.
- 명시적 ReviewDecision 없는 P4-to-P1 승격은 실패합니다.
- Canon 기준이 바뀌면 파생 pointer 게시를 거부하고 변경된 Canon 바이트를 보존합니다.
- checkpoint 생성 후 ResultPacket 증거를 삭제해도 `nextExpectedResult` 복구가 달라지거나 막히지 않습니다.
- receipt는 자신이 이름으로 지정한 그래프에는 없고 이후 child에만 나타납니다.
- 로컬, in-memory, 활성화된 GraphDB backend는 동일한 의미 GraphSnapshot과 TraversalResult identity를 보존합니다.
- reply는 ReviewDecision을 하나도 만들지 않으며, provider 요약은 checkpoint digest나 field를 변경할 수 없습니다.

선택적 Worker Admission은 P5 Host 운영 상태입니다. queue, reservation,
generation, capacity, expectation 및 status record는 P1 review, P2 recovery
direction, P3 result meaning, Product Canon 또는 wave completion을 만들거나
수정할 수 없습니다. Admission 상태 누락은 영향받은 admission domain만
차단하며 일반 Core recovery와 admission을 사용하지 않는 실행은 기존 계약을
그대로 따릅니다.

## 그래프 탐색, 공통 방향과 세션

`ProjectDirection`은 현재 사용자의 공통 goal/constraints/decisions/cancelledActions를
보존하는 P2 기록입니다. 정확한 기준의 갱신은 경합한 지시를 무조건 덮어쓰지 않습니다.
방향 필드나 그래프에서 읽은 과거 승인이 실행 authorization을 만들지는 않습니다.
여러 논리 Session이 요청별로 독립 진행·복구를 유지하며 기본 Session을 바꾸지 않습니다.
과거 체크포인트 필드는 그대로 복원하고 현재 공통 방향을 별도로 적용합니다.

`ProjectGraphDiscoveryProjection`과 교체 가능한 `ProjectGraphObservationIndex`는 P4입니다.
작업/Product 관점은 같은 원본을 참조합니다. 범위 내 탐색은 미승인·거절·과거 근거를
원래 상태, 기준, 리비전과 함께 읽으며 관계 확장에도 상태를 유지합니다. 이는 Canon
컴파일의 후보 제외 규칙을 바꾸거나 승인을 현재 실행 권한으로 승격하지 않습니다.
전체 World current, Product 승인, Run/Capsule, DB와 무관하게 유효한 층을 탐색하며
손상된 층만 제외합니다. 부분·빈 결과는 사실 부재의 증명이 아니고 원본 fallback을
제공합니다. 같은 기준의 결과/실패는 재사용하고 읽기는 승인·checkpoint를 만들지 않습니다.

## Canon 게시 조정

온보딩 승격과 Product Policy 수락은 기존의 짧은 `session-recovery` scope 안에서 Canon을 게시합니다. 문서 검토 Canon 적용도 같은 scope에 참여하고 검토한 preimage를 재검증합니다. 어떤 경로도 비동기 projection 작업 동안 이 scope를 보유하지 않습니다. World refresh는 기존 writer lease 이후 이 scope에 진입할 수 있습니다. Canon 게시자는 scope를 먼저 해제한 뒤 파생 refresh를 요청하므로 역순 잠금을 피합니다. 새 초기화는 collision 검사로 아직 게시되지 않은 Project를 생성하며 기존 Canon 교체 경로가 아닙니다. 충돌 시 immutable snapshot 준비물이 남을 수 있지만 권한을 부여하거나 current pointer를 전진시키지 않습니다.

내장 Activated ArcadeDB 경로도 실제 local mirror pointer 게시와 원격 게시를 분리합니다. 짧은 Canon commit scope에는 로컬 Graph·World current pointer 쓰기만 들어갑니다. 원격 pointer·topology activation·sync receipt 작업은 scope를 해제한 뒤 실행하며, 기존의 원격 관측 전 unavailable 상태에만 허용하는 fallback을 유지합니다. 원격 무결성·권한·불확실한 쓰기 실패는 오류로 남습니다. 성공 receipt를 만들거나 새 Canon/current pointer를 rollback할 수 없습니다. 오류 문구에는 확인된 로컬 게시와 완료되지 않은 외부 작업을 구분합니다. 로컬·원격 저장소 전체의 원자적 트랜잭션을 보장하지 않습니다.

원격 게시를 기다린 뒤에는 실제 현재 local mirror를 다시 읽고 나서만 topology/sync receipt가 `localMirrorVerified`를 주장할 수 있습니다. 직접 materialize도 성공 반환 전에 실제 local current를 재검증합니다. World 완료는 실제 파싱에 사용한 Canon 바이트와 예상 current World pointer를 다시 확인합니다. 더 새 local/current 값은 보존하고, 확인된 이전 원격 효과와 함께 충돌로 보고합니다. 자동 재실행이나 rollback은 추가하지 않습니다.

[영어 원문](../temporal-provenance.md)

# Temporal provenance GraphSnapshot alpha

이 plane을 변경하기 전에 [`architecture.md`](architecture.md)와 [`authority-plane-contract.md`](authority-plane-contract.md)를 읽으세요.

## 목적과 권한

temporal provenance graph는 Git이나 GraphDB를 제품의 필수 조건으로 만들지 않으면서, 시간에 따라 사용자 소유 제품 의도, 불변 onboarding review 이력 및 관찰된 저장소 상태를 연결합니다. 이는 검증된 Product Canon, 불변 onboarding 아티팩트, 현재 지원되는 소스 스캔 및 명시적 parent ID에서 파생되는 결정론적이고 재구축 가능한 `GraphSnapshot`입니다. 이는 Context Compiler 순회를 위한 증거입니다. 그래프에 Canon, candidate 또는 review projection을 저장하더라도 그래프가 project canon, instruction authority 또는 promotion authority가 되지는 않습니다.

graph builder는 다음과 같은 제공자 중립적 입력만 사용합니다.

- 프로젝트 ID
- 정규화된 `.lode/context/product-model.json` 콘텐츠와 그 evidence ID
- digest 검증을 거친 onboarding 아티팩트, FeatureMappingCandidateSets와 mapping ReviewDecisions, change-impact review 아티팩트를 갖춘 제공자 중립적 ChangeSets, Product Operating Loop 아티팩트 및 선택적 불변 VCS evidence attachment
- 정규화된 파일 경로, SHA-256 콘텐츠 digest, classification, language 및 추출된 symbol
- 0개 이상의 명시적 parent `SourceSnapshot` ID
- 안정적인 logical entity ID를 키로 하는 선택적 parent Revision ID 0개 이상

Evidence로만 사용되는 Git commit, branch, tag, GraphDB record ID, provider session ID, document-provider page ID, observation timestamp 및 line location은 필수 logical entity 및 ChangeSet ID에서 제외됩니다. 이를 포함하는 World Model에는 선택적으로 Git history가 별도로 들어갈 수 있습니다. temporal GraphSnapshot은 live Git state를 사용하지 않으며, 별도로 영속화되고 digest 검증을 거친 `VcsEvidence`와 release-observation projection input만 사용합니다.

## Logical entity와 불변 revision

Temporal provenance 어휘 `0.15.0`은 [`AuthorityPlaneContract`](authority-plane-contract.md) 아래에 P4 재구축 가능 relation 및 retrieval index를 구체화합니다. 새 World Model graph는 저장 형식과 관계없이 기존 `0.16.0` 안정 관계 producer를 사용합니다. digest가 유효한 과거 `0.2.0`부터 `0.15.0`까지의 원본은 바이트·식별자·pin을 다시 쓰지 않고 계속 읽습니다. 어휘에는 범위가 한정된 opaque historical onboarding reference와 기존 Policy·Observation projection이 포함됩니다.

- 안정적인 product logical entity: `FeatureGroup`, `Capability`, `Feature`, `Requirement`, `Constraint`, `Decision`, schema-v2 `Policy`
- 불변 product state: 이에 대응하는 `*Revision` kind
- 안정적인 implementation logical entity: `Repository`, `File`, `Symbol`, `Test`
- 불변 implementation state: `FileRevision`, `SymbolRevision`, `TestRevision`
- temporal root 및 외부 ancestry reference: `SourceSnapshot`, `SourceSnapshotReference`, `RevisionReference`
- onboarding evidence 및 review history: `OnboardingCandidateSet`, `OnboardingProductCandidate`, `OnboardingEvidence`, `OnboardingUnknown`, `OnboardingReviewDecision`, `ProductConceptReference`, `ProductModelRevision`
- 범위가 한정된 historical onboarding continuity: opaque `HistoricalOnboardingCandidateReference` node와 권한이 없는 `HISTORICALLY_FOLLOWS` edge. 정확한 `typedRevisionIds` 및 `opaqueRevisionIds` coverage는 projection된 revision set과 일치해야 하며 P1 또는 recovery authority를 부여할 수 없습니다.
- mapping review history: `FeatureMappingCandidateSet`, `FeatureMappingCandidate`, `FeatureMappingEvidence`, `FeatureMappingUnknown`, `FeatureMappingReviewDecision`, `ReviewedRelationship`, 과거의 `MappingEndpointReference`
- change lineage: `ChangeSet`, `ChangeRevisionReference`, execution-lineage reference, `ChangeImpactCandidateSet`, `ChangeImpactCandidate`, `ChangeImpactUnknown`, `ChangeImpactReviewDecision`, `ReviewedImpact`, 과거의 product reference
- 선택적 외부 change evidence: `VcsEvidence` 및 불변 `GitCommit` observation node. attachment가 없을 때는 이러한 node가 생략되며 ChangeSet을 절대 대체하지 않습니다.
- document review lineage: 숨겨진 `DocumentChangeCandidateSet` 및 `DocumentChangeCandidate` node와 일반적으로 표시되는 `DocumentChangeReviewDecision`, `DocumentProductModelRevision`, `DocumentChangeApplication` 및 과거 `DocumentProjectionReference` evidence
- product operating evidence: `ProductSignal`, `ProductHypothesis`, 숨겨진 `ProductInitiativeCandidate` 및 `ProductFeatureCandidate`, 과거의 `ProductFeatureReference`, 명시적인 `ProductInitiativeReviewDecision`, 별도의 `ReviewedProductInitiative` 및 execution-bound `OutcomeObservation` node
- release evidence: `BranchStateObservation`, `DeploymentResultObservation`, `ReleaseObservation` 및 내장된 불변 `GitCommit` observation
- Policy review history: 숨겨진 `ProductPolicyCandidate`와 `ProductPolicyEvidence`, 명시적 `ProductPolicyReviewDecision`, historical `ProductModelRevisionReference`, 그리고 semantic content가 승인된 proposal과 일치하는 정확한 현재 `PolicyRevision`
- common observation 및 measurement evidence: `ObservationTypeDescriptor`, `ObservationCollectionReceipt`, `ObservationRecord`, `DerivedObservationRecord`. Interpretation은 graph authority 밖에 남습니다. 검증된 대상별 delivery event는 exact current `FileRevision` 또는 derived historical `RevisionReference`를 가리킬 수 있습니다.

대화의 임시 학습 내용은 GraphSnapshot에 들어가지 않습니다. v0.2 Initiative candidate는 inline reasoning을 포함하면서 Feature resolution은 없을 수 있습니다. review 전까지는 `PROPOSES_TO` edge가 없고, 영속화된 hypothesis reference가 없으면 `PROPOSES_FROM` edge도 없습니다. 명시적 accept review는 별도의 reviewed Initiative에서 기존 Feature, Feature candidate 또는 정직하게 기록된 gap 중 정확히 하나를 해석합니다. candidate byte는 변경되지 않습니다.

Product logical ID는 project ID, entity kind 및 안정적인 user-owned key에서 파생됩니다. Feature의 이름을 바꿔도 logical ID는 보존되지만, 의미론적 편집은 새로운 FeatureRevision을 만듭니다. `File` ID는 project ID와 정규화된 path에서 파생됩니다. `Symbol` ID는 line number가 아니라 File ID, kind, name 및 결정론적인 same-name occurrence에서 파생됩니다. `Test` ID는 project ID와 path에서 파생됩니다. Revision ID는 logical ID, semantic state 및 정렬된 parent Revision ID에서 파생됩니다. 따라서 line을 이동해도 Symbol logical ID는 보존되지만 SymbolRevision은 변경됩니다.

`SourceSnapshot` ID에는 project, 완전하게 정렬된 현재 Revision set, ancestry-independent state digest, producer version 및 정렬된 0개 이상의 parent SourceSnapshots가 포함됩니다. 첫 번째 schema version부터 multiple parent가 지원됩니다. 이는 DAG shape만 기록하며, automatic merge, conflict detection, conflict resolution 및 ancestry fetching은 계속 유보됩니다.

## Provenance-complete projection

새 관계 정체성은 논리 관계와 내용 revision을 전역 스냅샷 소속에서 분리합니다.
정확한 endpoint·Project·endpoint 연속성 세대·근거·권한·confidence·producer와 분석 기준은
계속 입력에 포함됩니다. 다른 SourceSnapshot을 가리키는 관계는 정확한 endpoint가 다릅니다.
실험용 domain-bundle 저장 형식을 켤 필요는 없습니다.

읽기 전용 계보 diff는 기존 `changes`와 페이지 동작을 유지합니다. 별도의
`changeExplanation`이 내용 변경과 전역 `sourceSnapshotId` 소속만 바뀐 기록을 구분합니다.
나머지 필드는 모두 비교하며, 관계 짝이 모호하면 따로 유지합니다. 옛 writer에서 새 writer로
처음 넘어가는 경우를 포함해 producer·분석 기준 전환도 표시합니다. 이는 기록 필드의 기계적
비교이며 의미적 연속성·승인·충분성의 판정이 아닙니다. 설명 예시는 같은 선택 범위 안에서
제한해 보여주고, 원시 diff 페이지와 정확한 과거 스냅샷 조회는 계속 사용할 수 있습니다.

projection된 모든 node는 `nodeId`, `kind`, `authorityClass`, `origin`, 정렬된 `evidenceIds`, `freshness`, producer ID와 version 및 instruction/promotion authority boolean flag를 기록합니다. Snapshot-scoped node는 `sourceSnapshotId`도 기록하고, Revision node는 logical entity와 정렬된 parent ID를 기록합니다.

모든 edge는 `edgeId`, typed endpoint 및 `sourceSnapshotId`와 함께 동일한 authority 및 provenance surface를 기록합니다. Heuristic Symbol node와 relation은 numeric confidence를 포함합니다. 현재 구현된 relation subset은 다음과 같습니다.

- `CONTAINS`
- `REALIZES`
- `GOVERNED_BY`
- `HAS_REVISION`
- `CURRENT_REVISION`
- `PARENT_OF`
- `DECLARES`
- `REFERENCES`
- `PROPOSES_FROM`, `PROPOSES_TO`, `SUPPORTED_BY`
- `REVIEWED_BY`, `ACCEPTED_BY`, `REJECTED_BY`
- `PRODUCES` 및 `PROMOTED_FROM`. onboarding에서 `revise ReviewDecision -[:PRODUCES]-> successor CandidateSet`은 `accept ReviewDecision -[:PRODUCES]-> ProductModelRevision`과 구별됩니다.
- `HISTORICALLY_FOLLOWS`를 통한 비권위적 historical continuity
- review를 거친 canonical `IMPLEMENTS` 및 `VERIFIED_BY` edge
- 제공자 중립적 `CHANGES` 및 `SUPERSEDES` lineage와 명시적으로 review를 거친 `IMPACTS` edge
- 선택적 `ChangeSet -[:MATERIALIZED_AS]-> VcsEvidence -[:REFERENCES]-> GitCommit` evidence link
- `SUPPORTED_BY`, `PROPOSES_FROM`, `PROPOSES_TO`, review/promotion relation 및 `OutcomeObservation -[:OBSERVES]-> ChangeSet|ReviewedProductInitiative`를 통한 product learning 및 observation
- `AT_REVISION`, `OBSERVED_ON`, `EVIDENCED_BY` 및 선택적 `ReleaseObservation -[:DEPLOYS]-> ChangeSet`을 통한 release evidence
- `PROPOSES_FROM`, `PROPOSES_TO`, `SUPPORTED_BY`, `REVIEWED_BY`, `ACCEPTED_BY`, `REJECTED_BY`, `PRODUCES`, `REFERENCES`를 통한 Policy proposal 및 approval과, 선택적 semantic reference가 명시된 경우 정확한 Policy-to-Requirement/Constraint/Decision `GOVERNED_BY` edge. 이후 무관한 Product Model 변경이 생겨도 변경되지 않은 현재 `PolicyRevision`으로 이어지는 accepted ReviewDecision path는 사라지지 않습니다.
- `CONFORMS_TO`, `EVIDENCED_BY`, `DERIVED_FROM`을 통한 common Observation shape 및 derivation. 검증된 `delivery.state` record는 exact retained source revision에 한해 `AT_REVISION`도 사용할 수 있습니다. declared-only revision 문자열에는 graph edge를 만들지 않습니다.

verifier는 digest mismatch, 지원되지 않는 node 또는 relation type, 중복 ID, 비결정적 순서, dangling 또는 invalid endpoint kind, 누락된 provenance, invalid authority flag, invalid confidence, scope mismatch 및 직접적인 self-parent cycle을 거부합니다.

비지속 graph-lineage trace는 결과에 포함된 Policy evidence를 위한 bounded currentness diagnostic을
추가할 수 있습니다. 안전한 local source만 64 MiB까지 다시 hash하고 `unchanged`, `changed`,
`missing`, `not-assessed`를 보고합니다. External evidence와 실패한 bounded read는
`not-assessed`로 남습니다. 이 read-time P4 diagnostic은 historical graph를 다시 쓰거나 의미를
재평가하거나 accepted ReviewDecision을 무효화하거나 review gate를 만들지 않습니다.

## 결정론적 제한 순회

`queryTemporalProvenanceGraph`는 먼저 전체 GraphSnapshot을 검증한 다음 temporal traversal protocol `0.3.0`을 구성합니다. anchor mode는 명시적 검색용 `lexical-discovery`와 Lode가 의미 분석 후 제공하는 `exact-head-proposed` 중 하나입니다. exact mode는 1~32개의 고유 node ID와 현재 `expectedGraphSnapshotId`를 요구하며, 모든 anchor가 요청한 kind·authority·freshness·confidence·candidate policy를 충족해야 합니다.

- node-kind, relation, authority-class 및 freshness allowlist
- minimum confidence
- CandidateSet, candidate, Evidence, Unknown, ProductConceptReference, ProductInitiativeCandidate, ProductFeatureCandidate, ProductPolicyCandidate 및 ProductPolicyEvidence node를 기본적으로 제외하고 명시적 `includeUnreviewedCandidates` opt-in 제공
- maximum depth, node count 및 edge count
- anchor ID 및 결정론적 순서

lexical discovery는 task relevance를 증명하지 않습니다. exact anchor는 relation이나 bound를 확대하지 않으며 stale, missing, cross-snapshot 또는 ineligible anchor는 fail closed됩니다. 어느 mode도 Product Canon, ReviewDecision 또는 P2 recovery direction을 쓸 수 없습니다.

result는 graph, query 및 result ID와 hash, 선택된 node와 edge, inclusion reason, exclusion count 및 truncation을 기록합니다. 이후 backend가 이 algorithm을 가속할 수 있지만 allowlist를 넓히거나, semantic result의 순서를 바꾸거나, stale evidence를 허용하거나, digest를 변경해서는 안 됩니다.

## CLI 및 MCP

```text
node scripts/lode.mjs world-index <project> --parent-snapshot <id,id>
node scripts/lode.mjs world-index <project> --revision-parents <json-file>
node scripts/lode.mjs world-temporal <project> --query <text> --kind File,FileRevision --relations HAS_REVISION,CURRENT_REVISION --depth 1 --limit 100 --edge-limit 200
node scripts/lode.mjs world-temporal <project> --anchor-ids <node-id,node-id> --graph-snapshot <graph-snapshot-id> --relations HAS_REVISION,CURRENT_REVISION --depth 1 --limit 100 --edge-limit 200
node scripts/lode.mjs world-temporal <project> --query <candidate-id> --kind FeatureMappingCandidate,FeatureMappingEvidence --include-candidates true --depth 1 --limit 100 --edge-limit 200
node scripts/lode.mjs world-temporal <project> --query <change-set-id> --relations CHANGES,IMPACTS,SUPERSEDES --depth 3 --limit 200 --edge-limit 400
node scripts/lode.mjs world-temporal <project> --query <change-set-id> --relations MATERIALIZED_AS,REFERENCES --depth 2 --limit 200 --edge-limit 400
```

`--revision-parents`는 key가 현재 logical entity ID이고 value가 parent Revision ID array인 JSON object를 읽습니다. read-only MCP tool `lode_temporal_graph`는 `include_unreviewed_candidates`를 통해 동일한 제한 순회를 노출합니다. 둘 다 stale World Model을 거부합니다. ReviewDecision 및 ProductModelRevision receipt는 일반적인 reviewed traversal에서 계속 표시됩니다. unreviewed candidate surface에는 명시적 opt-in이 필요하며, opt-in하더라도 권한에는 영향을 주지 않습니다.

Context Compiler는 task-token overlap으로 temporal anchor를 추론하지 않습니다. Lode가 `temporal-relation` EvidenceNeed에 현재 exact `graphAnchor`를 붙이면 Core는 Project·World Model·GraphSnapshot·node eligibility·relation allowlist·traversal bound를 검증한 뒤 별도 `GraphTraversalEvidence` carrier를 만듭니다. Local JSON, in-memory 및 활성 ArcadeDB adapter는 정확한 reference result를 반환해야 하며 adapter identity는 Capsule identity 바깥에 유지됩니다. [`graph-projection-adapter.md`](graph-projection-adapter.md)를 참조하세요.

review된 execution change는 `ChangeSet` record를 정확한 before/after source revision에 결속합니다. review를 거친 current product impact는 정확한 Feature 또는 Capability revision에도 `AT_REVISION`으로 결속되며, 이후 drift가 생기면 historical receipt는 유지하되 current-impact claim은 제거합니다. Git ref만으로는 `DeploymentResultObservation` 또는 `ReleaseObservation`을 만들지 않습니다. Delivery lineage는 Host가 별도로 승인되고 성공했으며 exact commit이 일치하는 deployment evidence를 제출한 뒤에만 나타납니다.

대상별 delivery genealogy는 이 release path와 구분됩니다. Host는 Git 없이도 명시적인 applied, failed, cancelled, rolled-back `delivery.state` event를 기록할 수 있습니다. Graph는 기계적으로 검증된 retained source revision만 연결하고, 현재 target state는 explicit sequence와 predecessor evidence를 사용하는 별도의 bounded P4 read projection입니다. Release approval, environment completeness 또는 unobserved target success를 추론하지 않습니다. [`delivery-observation.md`](delivery-observation.md)를 참고하세요.

active deterministic Markdown renderer는 indexing 후 `DocumentProjectionAdapter`를 통해 검증된 이 graph를 사용합니다. canonical edge direction을 보존하고, relation endpoint를 node page에 연결하며, 정확한 GraphSnapshot 및 SourceSnapshot ID를 기록합니다. 생성된 page는 human view일 뿐이며, 절대 Context Compiler input으로 다시 순회되지 않습니다. 편집된 page는 비권위적 `DocumentChangeCandidateSet` evidence가 됩니다. 명시적 review는 이후 child graph로 projection되며, application receipt가 실제 application outcome을 결합한 다음 그다음 audit child graph가 해당 receipt를 projection합니다. 이 two-stage boundary는 동일한 GraphSnapshot의 이름을 가진 receipt에 GraphSnapshot hash가 종속되는 문제를 방지합니다. Context Compiler는 document candidate surface를 opt-in하지 않습니다. [`document-projection-adapter.md`](document-projection-adapter.md) 및 [`document-change-review.md`](document-change-review.md)를 참조하세요.

## 유보된 경계

이 beta는 아직 commit-to-ChangeSet matching이나 프로젝트 전체 execution lineage를 추론하지 않으며 구현된 review scope를 넘어 general candidate를 승격하지 않습니다. Local/in-memory 및 명시적으로 활성화된 ArcadeDB GraphProjectionAdapter는 구현되어 있습니다. Obsidian, Notion과 ArcadeDB 이외의 remote graph transport는 유보됩니다. 이 시스템은 parent revision이나 ChangeSet ancestry를 추론하거나, merge를 수행하거나, candidate를 자동 승격하거나, current-state pointer를 Canon으로 취급하지 않습니다.

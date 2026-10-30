# Product Model Canon

[영어 원문](../product-model.md)

이 계약을 변경하기 전에 [`architecture.md`](architecture.md)와
[`authority-plane-contract.md`](authority-plane-contract.md)를 읽으세요.
Product Model은 사용자가 소유하는 제품 의도를 기록합니다. 저장소 layout, 생성된 graph,
Git history, validation fixture 또는 model output에서 권한을 추론하지 않습니다.

## 권한과 lifecycle

`.lode/context/product-model.json`은 `FeatureGroup`, `Capability`, `Feature`,
`Requirement`, `Constraint`, `Decision` 및 선택적 schema-v2 `Policy`를 위한 변경 가능한
프로젝트 Canon입니다. 새 프로젝트 초기화는 명시적으로 빈 schema-v1 document를 생성합니다.
기존 schema-v1 byte, protocol, hash, read 및 replay 동작은 정확히 유지되며, schema v2는
명시적으로 승인된 Policy candidate 또는 이미 권한이 있는 완전한 Product Model 쓰기를 통해서만
진입합니다. 이 파일 없이 초기화된 이전 프로젝트는 authorized process가 파일을 생성할 때까지
같은 빈 semantic model로 해석되므로 migration이 제품 의미를 만들어내지 않습니다.

빈 Product Model은 “Lode에 아직 승인된 product concept가 없다”는 뜻입니다. 기존 source
file, test, README heading, issue 또는 directory name은 Evidence로 남으며 자동으로
Feature가 되지 않습니다. 활성 온보딩 flow는 bounded current repository evidence에 근거한
provider Lode semantic proposal 또는 structured new-project brief에서 변경 불가능한 candidate를
정규화할 수 있지만, 이 Canon으로 승격하려면
명시적인 batch ReviewDecision이 필요합니다. Directory structure는 authoritative
FeatureGroup taxonomy로 절대 변환되지 않습니다.

## Schema

Stable `key` value는 rename 및 description 변경 전후에도 logical product entity를
식별합니다. Name과 description은 identity가 아니라 revision content입니다. Reference는
key를 사용하며 model을 index하기 전에 검증됩니다.

```json
{
  "schemaVersion": 2,
  "featureGroups": [
    {
      "key": "communication",
      "name": "Communication",
      "description": "User-facing communication experiences.",
      "parentFeatureGroupKeys": []
    }
  ],
  "capabilities": [
    {
      "key": "message-delivery",
      "name": "Message delivery",
      "description": "Deliver a message to its intended recipients."
    }
  ],
  "features": [
    {
      "key": "direct-message",
      "name": "Direct message",
      "description": "Send a message to one recipient.",
      "featureGroupKeys": ["communication"],
      "capabilityKeys": ["message-delivery"],
      "governedBy": [
        { "kind": "Requirement", "key": "delivery-confirmation" }
      ]
    }
  ],
  "requirements": [
    {
      "key": "delivery-confirmation",
      "statement": "Accepted messages expose delivery confirmation.",
      "description": ""
    }
  ],
  "constraints": [],
  "decisions": [],
  "policies": [
    {
      "key": "human-review",
      "name": "Human review",
      "description": "Require review for the selected product surface.",
      "statement": "Changes to communication require explicit user review.",
      "status": "active",
      "appliesTo": [
        { "kind": "FeatureGroup", "key": "communication" }
      ],
      "governedBy": [
        { "kind": "Requirement", "key": "delivery-confirmation" }
      ]
    }
  ]
}
```

Key에는 letter, digit, dot, underscore, colon 또는 hyphen을 사용합니다. Key는 각 entity
kind 안에서 고유해야 합니다. FeatureGroup parent relation은 acyclic이어야 합니다.
group, capability, requirement, constraint 및 decision을 가리키는 Feature reference는
해석되어야 합니다. Decision에는 `status: "active"` 또는 `"superseded"`가 있습니다.
Policy에는 `status: "active"` 또는 `"retired"`가 있으며 명시적으로 지정한 Feature 또는
FeatureGroup key에만 적용됩니다. 선택적 `governedBy` reference로 정확한 Requirement,
Constraint 또는 Decision key를 인용할 수 있고 빈 reference도 유효합니다. 적용 대상이나
semantic reference는 group membership에서 추론되지 않습니다.

## Policy 제안과 검토

대화에서 Lode는 `lode_product_policy_propose`를 사용해 정확한 현재 Product Model을 기준으로
create, revise 또는 retire 불변 candidate 하나를 기록할 수 있습니다. Proposal은 bounded local
source evidence와 정확한 semantic reference를 인용할 수 있지만 선택적 evidence 또는 reference가
없다는 사실은 gate가 아니라 disclosure입니다. Canon을 변경하거나 일반 작업을 막지 않습니다.
Lode는 의미, 정확한 적용 대상, reference, evidence 상태 및
영향을 작은 decision card 하나로 제시하며, 현재 사용자의 명확한 결정 뒤에만
`lode_product_policy_review`를 호출할 수 있습니다. `lode_product_policy_status`는 읽기 전용
inspection surface입니다.

Acceptance만 보호된 전이입니다. 현재 Session, Product Model base, active Run conflict, candidate
identity 및 결속된 local evidence를 다시 검사한 다음, 공통 mutation lock 아래에서 ReviewDecision을
기록하고 정확한 schema-v2 결과를 씁니다. Exact replay는 같은 불변 결정에서 누락된 출력만
완성하고 결정을 다시 묻지 않습니다. 승인된 Canon이 이미 게시됐다면 누락된 derived projection만
복구합니다. Rejection은 Canon을 변경하지 않고 disposition만 기록합니다.
Candidate와 ReviewDecision artifact는 감사를 위해 graph에 projection되며 두 번째 Policy store는
만들지 않습니다.

Review 이후 source evidence가 바뀌어도 승인된 Policy를 조용히 개정하거나 무효화하지 않습니다.
Status와 lineage trace는 하나의 공통 bounded P4 currentness projection을 보여 줍니다. 각 source는
`unchanged`, `changed`, `missing`, `not-assessed` 중 하나이며 external evidence는
`not-assessed`로 남습니다. Byte freshness는 semantic reassessment가 아니고 자동으로 두 번째
review를 요구하거나 일반 작업을 막지 않습니다. 현재 task에 필요하면 Lode가 이 disclosure를
새 proposal의 evidence로 사용할 수 있습니다.

## Temporal projection

Indexing은 array 및 object field를 정규화하고 `productModelHash`를 도출하며, 각 logical
product entity와 하나의 변경 불가능한 current Revision을 temporal GraphSnapshot으로
project합니다. logical entity의 name 또는 description이 바뀌어도 project 범위 identity는
그대로 유지됩니다. semantic content 또는 명시적으로 정렬된 parent가 바뀌면 Revision
identity가 바뀝니다.

Product relation은 다음과 같은 하나의 canonical direction을 사용합니다.

- `FeatureGroup -CONTAINS-> FeatureGroup`
- `FeatureGroup -CONTAINS-> Feature`
- `Feature -REALIZES-> Capability`
- `Feature -GOVERNED_BY-> Requirement|Constraint|Decision`
- `Policy -GOVERNED_BY-> Requirement|Constraint|Decision`, 명시적인 semantic reference에 한함
- `Feature|FeatureGroup -GOVERNED_BY-> Policy`, 명시적인 Policy application에 한함
- logical entity `-HAS_REVISION->` 및 `-CURRENT_REVISION->` immutable Revision

이 node와 relation은 Canon의 파생 view이므로 `authorityClass: "canon-projected"`를
가집니다. 그래도 `instructionAuthority: false`와 `promotionAuthority: false`입니다.
GraphSnapshot은 Canon의 projection을 포함한다는 이유만으로 Canon이나 authority
mechanism이 되지 않습니다.

Whitespace, object-field ordering 및 set-like reference ordering은 semantic Product Model
identity를 바꾸지 않습니다. semantic change가 발생하면 explicit re-indexing이 새롭고
변경 불가능한 snapshot을 생성하고 검증할 때까지 저장된 World Model은 stale 상태가 됩니다.

## Query 및 Context Compiler 동작

`world-index` 후에는 같은 bounded temporal query contract로 product concept를 탐색할 수 있습니다.

```powershell
node scripts/lode.mjs world-temporal <project> --query "Message delivery" --kind Feature,FeatureRevision,Capability --relations REALIZES,HAS_REVISION,CURRENT_REVISION --depth 2 --limit 100 --edge-limit 200
```

Context Compiler는 current verified World Model에서만 task-relevant bounded Product Context를
포함할 수 있습니다. GraphSnapshot, query 및 result digest를 기록하고,
`canon-projected` product relation만 허용하며, review되지 않은 candidate는 제외합니다.

## 온보딩 승격

프로젝트 범위 온보딩 상태 머신은 candidate set과
`decisionScope: "product-canon-bootstrap"` ReviewDecision을 이 파일과 별도로
저장합니다. Candidate는 content-derived identity와 함께 evidence, confidence, producer,
source snapshot 및 명시적인 false instruction/promotion authority flag를 가집니다.
`accept-all` 및 dependency-complete `accept-selection`은 stale-source, Product Canon
drift, conflict 및 reference check를 통과한 뒤에만 새로운 normalized Product Model을
생성합니다. `revise`는 후속 candidate set을 생성하며, `reject`는 Canon을 변경하지 않습니다.

수락은 이전 및 결과 Product Model identity와 변경 불가능한 Product Model revision
document를 기록합니다. 그런 다음 child SourceSnapshot을 다시 빌드하고, 새 Product Model
identity가 current temporal GraphSnapshot에 존재함을 검증한 뒤에야 온보딩이 ready가 됩니다.
전체 state 및 input contract는 [`onboarding.md`](onboarding.md)를 참조하세요.

Temporal graph는 concept가 Canon에 도달한 과정을 설명하는 데 필요한 변경 불가능한
candidate, Evidence, Unknown, ReviewDecision 및 ProductModelRevision receipt도 project합니다.
이 receipt는 Product Model entity가 되지 않습니다. Candidate node는 별도의
`ProductConceptReference` node를 가리키며, review를 거친 결과
`.lode/context/product-model.json` content만 `canon-projected` Product entity 및 revision을
생성합니다.

## 문서 변경 적용

편집된 generated Markdown은 proposal로 남으며 Product Canon으로 절대 parse되지 않습니다.
범위가 지정된 document-change ReviewDecision은 사용자가 이와 동일한 schema 및 identity
validation을 통과하는 완전한 Product Model을 제공한 경우에만 captured candidate set을
수락할 수 있습니다. Application은 candidate byte, review된 Canon identity 및 current
World Model을 검증하고, review를 거친 정확한 model을 작성하며, child SourceSnapshot 및
GraphSnapshot을 다시 빌드하고, 결과 Product Model projection을 검증한 다음 Markdown을
reconcile합니다. Rejection은 Canon을 변경하지 않고 view를 current graph와 reconcile합니다.
[`document-change-review.md`](document-change-review.md)를 참조하세요.

## 명시적으로 연기됨

이 범위에서는 추론된 코드 또는 문서 의미를 review 없이 Canon으로 취급하지 않습니다.
Feature-to-code, Feature-to-test 및 ChangeSet-to-product impact mapping은 별도의 변경 불가능한
candidate와 명시적인 ReviewDecision contract를 사용하지만 Product Canon을 변경하지 않습니다.
Provider-neutral ChangeSet은 제품 의도를 재정의하는 대신 review된 change lineage를 기록합니다.
Deterministic Markdown은 파생된 GraphSnapshot view이며, 편집된 page는 Product Canon이 아니라
candidate가 되고, 그 review/application은 이후의 audit GraphSnapshot에 project됩니다.
Dedicated imported-backlog adapter, broader conformance relation 및 Obsidian/Notion projection은
계속 연기됩니다.

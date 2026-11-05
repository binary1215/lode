# 프로젝트 온보딩

일반 작업은 Core로 시작합니다. 이 문서는 선택적 Product 모델 설정을 다루며, 초기화 예제는 `--profile product`를 선택합니다.

[영어 원문](../onboarding.md)

이 계약을 변경하기 전에 [`architecture.md`](architecture.md)와
[`authority-plane-contract.md`](authority-plane-contract.md)를 읽으세요.
온보딩은 제품 권한을 부트스트랩할 뿐이며, 저장소 구조, 모델 추론, Git,
GraphDB, 검증 fixture 또는 provider 대화에 권한을 부여하지 않습니다.

## 상태와 권한

이제 초기화는 다음을 생성합니다.

- `.lode/sessions/records/` 아래의 변경 불가능한 프로젝트 범위 `LodeSession` 레코드
- digest가 검증된 `.lode/onboarding/current.json` 상태 포인터
- 변경 불가능한 로컬 기본값 `OnboardingStorageSelection`
- 비어 있으며 사용자가 소유하는 `.lode/context/product-model.json` Canon

Lode Session identity는 Claude Code, Codex, OpenCode 및 다른 모든 provider 대화 ID와
독립적입니다. 이전에 초기화된 프로젝트는 읽기 전용 검사에서 `migration_required`를
보고합니다. 다음 변경형 온보딩 명령은 기존 Session ID와 Product Model identity를
보존하면서 누락된 Session 레코드, 로컬 저장소 선택 및 상태 포인터를 생성합니다.

상태 포인터 protocol `0.2.0`은 가장 최근 결정을
`latestReviewDecisionId`로 명명합니다. 현재 Core는 상태 protocol `0.1.0`을 더 이상
해석하지 않습니다. 그 상태를 사용하는 프로젝트는 별도로 고정된 legacy migrator
또는 별도로 검토된 복구 경로가 필요합니다. 후속 candidate는 자신을 생성한 `revise` 결정을 별도로
`producerReviewDecisionId`로 명명합니다. 그 후속 candidate가 수락되거나 거부된
뒤에는 producer와 latest review가 의도적으로 서로 다릅니다.

상태 머신은 다음과 같습니다.

```text
initialized
  -> explicit World Model index
  -> awaiting-review | awaiting-evidence | ready(existing canon)
  -> revise -> successor immutable candidate set -> awaiting-review
  -> reject -> rejected
  -> accept-all | accept-selection
       -> new Product Model revision
       -> new child SourceSnapshot and verified GraphSnapshot
       -> ready
```

Fresh Lode semantic proposal과 user-owned brief는 `instructionAuthority: false`와
`promotionAuthority: false`를 지닌 `OnboardingCandidateSet` evidence를
생성합니다. Core는 symbol name, repository path, README heading 또는 lexical rule에서
product meaning을 추론하지 않습니다. 제안된 source path, digest, line, optional symbol,
Product Model reference와 resource bound를 현재 World Model에 대조해 검증합니다.
`decisionScope: "product-canon-bootstrap"`인 명시적
`ReviewDecision`만 Product Canon을 작성할 수 있습니다. candidate는 절대 변경되거나
라벨이 바뀌지 않습니다. revision은 새로운 identity를 가진 후속 candidate를 생성하며,
수락은 별도의 Canon과 변경 불가능한 decision receipt를 생성합니다.

Candidate protocol `0.4.0`은 project, Session, mode, 정확한 SourceSnapshot,
Product Model input, bounded semantic proposal, 검증된 Evidence, Unknowns, ancestry,
producer ReviewDecision 및 producer policy로부터 candidate-set identity를 도출합니다.
파생 World Model ID는 materialized-view pointer에 authority review를 결합하지 않도록
제외합니다. 폐기된 lexical-inference protocol의 candidate set은 거부하며,
현재 SourceSnapshot에 결속된 fresh Lode semantic proposal로 다시 만들어야 합니다.

## 과거 온보딩 경계

완료된 candidate protocol `0.1.0`부터 `0.3.0`은
[`onboarding-migrator.md`](onboarding-migrator.md)에 설명된 독립 실행 패키지만
해석합니다. 현재 플러그인은 이 parser를 배포·import·호출하지 않으며 MCP에도
노출하지 않습니다. 명시적인 one-shot apply는 create-only P3 boundary, 적용 receipt,
최종 commit marker만 기록합니다. 과거 candidate와 review는 opaque 상태로 남고,
현재 verifier를 독립적으로 통과한 Product Model revision만 기존 P1 지위를 유지합니다.

helper를 제거한 뒤에도 정상 status, World, Context, Session recovery와 새 current
온보딩은 계속 동작합니다. 제품 의미를 변경하려면 provider Lode가
`lode_onboarding_semantic_refresh` 또는 `onboarding-semantic-refresh`로 fresh current
semantic proposal을 작성하고, 사용자는 일반 ReviewDecision 경로에서 새 candidate를
검토합니다. 첫 current candidate는 historical candidate를 typed parent로 재사용하지
않습니다. P3 continuity receipt와 P4 `HISTORICALLY_FOLLOWS` edge는 역사적 연속성만
보존하며 instruction, recovery 또는 promotion 권한을 만들지 않습니다.

## 공개 initialize 및 resume 경로

권장되는 사용자 대면 경로는 Claude Code, Codex 또는 OpenCode 대화 안에 번들된
`lode-agent-onboarding` Skill입니다. 먼저 읽기 전용 `lode_onboarding_guide`
tool을 호출하고, 해결되지 않은 중요한 선택지만 질문한 다음, typed MCP operation을
통해 동일한 Core를 호출합니다.

- idempotent project 및 Lode Session 구성을 위한 `lode_project_initialize_or_resume`
- 명시적이며 evidence-linked candidate 결정을 위한 `lode_onboarding_review`
- 파생되고 복구 가능한 문서 view를 위한 `lode_markdown_projection_build`

Skill은 두 번째 온보딩 protocol을 만들지 않습니다. provider Lode는 현재 repository
evidence를 검사하고 typed `semantic_proposal`을 작성할 수 있지만, Core가 이를 검증하고
gate하며 사용자가 여전히 ReviewDecision을 소유합니다. Skill은 사용자 ReviewDecision을 추론하거나,
source scope를 넓히거나, GraphDB credential을 저장할 수 없습니다. MCP를 사용할 수
없다면 아래 CLI가 동등한 복구 및 자동화 surface입니다.

주요 공개 명령은 프로젝트 생성 또는 검증, 설치 projection convergence,
온보딩 시작 또는 재개를 구성합니다.

```powershell
node scripts/lode.mjs init C:\path\to\project --runtime claude,codex,opencode --input .\onboarding.json --profile product
node scripts/lode.mjs resume C:\path\to\project --runtime claude,codex,opencode --profile product
```

첫 번째 명령은 프로젝트 범위 Lode Session을 정확히 하나 생성하고 온보딩을
시작합니다. 반복 실행은 기존 project/runtime binding을 검증합니다. 대기 중인
candidate review 또는 준비된 Product Canon은 온보딩 포인터를 다시 쓰거나 중복된
authority artifact를 만들지 않고 반환됩니다. plugin upgrade 후에는 drift가 없는
관리형 OpenCode configuration만 검증된 새 release path로 converge합니다. 사용자가
수정했거나 소유권이 없는 configuration은 fail-closed 방식으로 실패합니다.

설치 중에도 같은 경로를 호출할 수 있습니다.

```powershell
.\scripts\install.ps1 --project C:\path\to\project --runtime claude,codex,opencode --onboarding-input .\onboarding.json --profile product
```

## 저수준 온보딩 재시작

이미 초기화된 프로젝트는 다음 저수준 명령으로 `initialized`,
`awaiting-evidence` 또는 `rejected` 온보딩 단계를 명시적으로 다시 시작할 수 있습니다.

```powershell
node scripts/lode.mjs onboarding-start C:\path\to\project
node scripts/lode.mjs onboarding-status C:\path\to\project
```

기존 프로젝트는 코드와 문서를 먼저 index합니다. user brief나 fresh Lode semantic
proposal이 없으면 온보딩은 명시적 Unknown과 함께 `awaiting-evidence`에서 멈추며,
코드 어휘로 product concept를 만들어 내지 않습니다. proposal은 최대 200개의
candidate를 담고 candidate마다 현재 source citation 1~8개를 가져야 하며, 전체 set은
evidence record 250개와 Unknown 100개로 제한됩니다. citation은 정확한 project-relative
path와 유효한 line을 명시하고, 정확한 indexed symbol 및 optimistic freshness guard인 digest를 선택적으로 추가할 수 있습니다. Core는 항상 검증된 현재 World digest를 직접 결속합니다.
stale, hallucinated, scope 밖, 과대 또는 구조적으로 잘못된 proposal은 fail closed됩니다.
유효한 proposal도 명시적인 user review 전까지 P3 candidate evidence입니다.

### 저장소 source scope

indexing 전에 사용자는 프로젝트 상대적인 observation boundary를 저장할 수 있습니다.
비어 있는 `includeRoots`는 적격 저장소 전체를 의미하며, `excludeRoots`가 항상 우선합니다.
Root는 glob이 아니라 정규화된 path이며, 선택은 instruction 또는 promotion authority가
없는 content-derived evidence입니다.

```json
{
  "includeRoots": [],
  "excludeRoots": [".generated-evidence", "bundled-third-party", "generated-copy"]
}
```

첫 index 전에 boundary가 존재하도록 이 object를 공개 `init --input` document 안의
`sourceScope`로 제공하세요. 저수준 `source-scope-set` command는 초기화된 project에서
명시적 `onboarding-start` 전에, 또는 이후 검토를 거친 rescan에 계속 사용할 수 있습니다.
정확한 scope identity는 `RepositoryScanResult` 및 World Model source digest에
포함됩니다. 이후 scope 변경은 기존 index를 stale 상태로 만들며, Product Canon 또는
수락된 Capsule을 절대 수정하지 않습니다.

새 프로젝트 brief는 review 전까지 candidate로 남으면서 Product Model entity schema를 사용합니다.

```json
{
  "mode": "new",
  "brief": {
    "schemaVersion": 1,
    "name": "Message service",
    "summary": "Deliver messages with explicit verification.",
    "featureGroups": [
      {
        "key": "group:communication",
        "name": "Communication",
        "description": "User-facing communication.",
        "parentFeatureGroupKeys": []
      }
    ],
    "capabilities": [
      {
        "key": "capability:delivery",
        "name": "Delivery",
        "description": "Deliver one accepted message."
      }
    ],
    "features": [
      {
        "key": "feature:direct-message",
        "name": "Direct message",
        "description": "Send one message to one recipient.",
        "featureGroupKeys": ["group:communication"],
        "capabilityKeys": ["capability:delivery"],
        "governedBy": []
      }
    ],
    "requirements": [],
    "constraints": [],
    "decisions": []
  }
}
```

```powershell
node scripts/lode.mjs init C:\path\to\project --input .\onboarding-start.json --profile product
```

Product Canon에 이미 승인된 entity가 있는 프로젝트는 candidate bootstrap을 건너뛰지만,
계속해서 implementation evidence를 index하고 Product Model projection을 검증한 뒤
`ready`에 진입합니다.

## 저장소 선택

로컬 materialization은 완전하며 기본값입니다. ArcadeDB는 필수 전제 조건으로 만들지 않고 선택할 수 있습니다.

```json
{
  "mode": "existing",
  "storage": {
    "mode": "graphdb",
    "endpoint": "https://graph.example.test",
    "database": "head",
    "secretReferenceNames": {
      "username": "LODE_GRAPHDB_USERNAME",
      "password": "LODE_GRAPHDB_PASSWORD"
    }
  }
}
```

endpoint, database 및 environment-style secret-reference name만 저장됩니다. 내장 URL
credential, password/token field 및 credential value는 거부됩니다. 변경 불가능한
selection은 선택 시점의 상태를 `pending-unverified-adapter`로 기록하며, 온보딩은 이를
명시적으로 공개하면서 로컬 JSON을 통해 계속됩니다.

`LODE_GRAPHDB_USERNAME`과 `LODE_GRAPHDB_PASSWORD`는 새 설정 예시에서 호출자가
선택한 참조 이름이며, 환경변수를 자동으로 연결하는 별칭 체계가 아닙니다.
기존 선택은 `HEAD_GRAPHDB_USERNAME`과 `HEAD_GRAPHDB_PASSWORD`를 포함해 저장된
정확한 이름을 유지합니다. 패키지 업데이트를 위해 이 이름을 바꾸거나 selection
digest를 다시 쓰지 마세요.

첫 current GraphSnapshot이 생긴 뒤, 대화 밖에서 참조된 두 environment variable을
주입하고 host를 재시작하여 plugin process가 이를 상속하게 하세요. 정상 대화 경로는
먼저 `lode_graphdb_connection_preflight`를 호출합니다. 이 exact-child check는 network
request를 수행하지 않으며, 구성된 reference name과 각각의 존재 여부 boolean만
반환합니다. credential, endpoint 또는 database value는 절대 반환하지 않습니다. 두
reference가 모두 있으면 Skill은 `lode_graphdb_database_status`를 호출하고, 명시적 사용자
확인을 받은 다음 `lode_graphdb_database_initialize`를 호출하며, 별도의 remote-write
확인을 받고 `lode_graphdb_projection_activate`를 호출합니다. 이러한 typed MCP operation은
confirmation과 exact-target reset evidence는 받지만 credential value는 절대 받지
않습니다. 동등한 recovery/automation CLI는 `world-graph-remote-database-status`,
`world-graph-remote-database-initialize`, `world-graph-remote-activate`입니다.

관련 없는 기존 schema는 compatible하며 보존됩니다. Reset은 Lode-reserved type과의
충돌이 입증된 경우에만 사용할 수 있고, MCP를 통해 `reset_incompatible: true`와 정확히
선택된 database가 필요하거나 CLI를 통해
`--reset-incompatible true --confirm-database <exact-selected-name>`이 필요합니다.
Activation은 검증되고 재개 가능한 GraphSnapshot delta를 upload하고, local adapter와
비교하여 완전한 reconstruction 및 bounded traversal equality를 입증한 다음,
exact-predecessor compare-and-swap으로 remote pointer를 전진시키고 별도의
content-addressed activation 및 sync receipt를 저장합니다. `world-graph-remote-status`,
`lode_graphdb_projection_status`, `lode_graphdb_database_status`는 credential 또는
target value를 노출하지 않고 operational state를 보고합니다. initialization 또는
activation 실패 시 완전한 local graph mirror가 recovery path로 남으며 Product Canon을
승격할 수 없습니다.

## 일괄 review

`onboarding-status` 또는 `onboarding-candidates`로 current candidate set을 읽으세요.
Review input은 정확한 current `candidateSetId`를 명시해야 합니다. stale source,
Product Canon drift, candidate tampering 또는 다른 set이면 fail-closed 방식으로
실패합니다.

모든 candidate를 수락합니다.

```json
{
  "candidateSetId": "onboarding-candidates-<24-hex>",
  "disposition": "accept-all",
  "rationale": "Adopt the reviewed bootstrap batch."
}
```

dependency-complete selection을 수락합니다.

```json
{
  "candidateSetId": "onboarding-candidates-<24-hex>",
  "disposition": "accept-selection",
  "acceptedCandidateIds": ["onboarding-candidate-<24-hex>"],
  "rationale": "Adopt only the reviewed capability."
}
```

Canon을 변경하지 않고 candidate를 수정합니다.

```json
{
  "candidateSetId": "onboarding-candidates-<24-hex>",
  "disposition": "revise",
  "userEdits": [
    {
      "candidateId": "onboarding-candidate-<24-hex>",
      "entity": {
        "key": "capability:delivery",
        "name": "Verified delivery",
        "description": "Deliver and verify one accepted message."
      }
    }
  ],
  "addedEntities": [],
  "removedCandidateIds": [],
  "rationale": "Use reviewed product language before promotion."
}
```

`revise`는 이전 set 및 그 producer ReviewDecision에 연결된 새로운 변경 불가능한
candidate set을 생성합니다. 이후의 수락 또는 거부는 그 후속 candidate에 대해 별도의
latest ReviewDecision을 기록하며, 두 identity가 일치할 필요는 없습니다. 추가와 제거에는
이 두 단계 review 경로가 필요합니다. 같은 결정에서 항목을 도입하고 승격할 수는 없습니다.
`reject`는 모든 candidate를 rejected로 기록하고 Product Canon을 변경하지 않습니다.

```powershell
node scripts/lode.mjs onboarding-review C:\path\to\project --input .\onboarding-review.json
node scripts/lode.mjs onboarding-review-read C:\path\to\project --review onboarding-review-decision-<24-hex>
```

## 승격과 복구

수락은 stable key와 reference를 검증하고 충돌을 거부한 뒤, 명시적 P1 ReviewDecision,
이전·결과 Product Model의 변경 불가능한 revision 순으로 기록합니다. 그 다음 Canon과
온보딩 pointer를 게시합니다. Graph 재구축은 이후에 수행하며 승인을 만들거나 취소할
수 없습니다. 공개 준비도는 승인된 identity의 current digest-verified projection이
있어야만 `ready`가 됩니다.

게시 중 중단되면 읽기 전용 status는 상태를 복구하거나 일반 Core 작업을 막지 않고
`promotion_recovery_pending`을 표시합니다. Product resume 또는 정확히 같은 재시도는
검증된 ReviewDecision과 revision으로 이미 승인된 전이를 완료합니다. 누락된 revision은
정확히 승인된 candidate·edit와 검증된 이전 Canon으로만 재구축하고 결과 hash가
해당 결정과 일치하는지 확인합니다. 사용자에게 중복
검토를 요구하지 않습니다. 다른 내용의 재시도, 변조된 revision, 무관한 현재 Canon은
승인된 결정이나 더 새로운 상태를 덮어쓸 수 없습니다. Graph 재구축만 실패하면
`onboarding_approved_projection_pending`으로 승인을 보존하고 남은 projection 작업을
알립니다. 부분 graph는 파생 증거이며 복구 권한이 아닙니다. 재시도마다 별도의
transaction artifact를 만들지 않습니다.

수정과 거부도 정확한 P1 결정을 먼저 저장한 뒤 후속 candidate나 phase pointer를
게시하고 Graph를 재구축합니다. 적용 중단은 `review_recovery_pending`, 파생 투영
게시 실패는 `onboarding_review_projection_pending`으로 표시합니다. Resume은 새로운
사용자 결정 없이 기록된 결정을 완료하며, 같은 요청의 재시도도 같은 결과로 수렴합니다.
단순 resume은 거부된 set을 거부 상태로 유지합니다. 저장되지 않은 결정이 남은 과거의
고아 Graph는 정본 artifact로 재구축하며, 그 Graph에서 누락된 결정을 만들어내지 않습니다.

World pointer나 snapshot 부재는 선택적인 파생 데이터의 유실이며 Product 승인이나
P2 방향의 유실이 아닙니다. 진입·status·Core resume은 읽기 전용으로 계속 사용할 수
있고 Product/Context의 refresh 필요성을 표시합니다. 명시적 Product resume은 보존된
artifact로 파생 뷰를 재구축할 수 있지만 Canon을 다시 승인하지는 않습니다. 잘못된
Canon·결정·digest 불일치는 무해한 부재로 분류하지 않고 계속 오류로 처리합니다.

Windows에서는 사용 중이지 않은 refresh lock의 게시도 일시적으로 거부될 수 있습니다.
P5 lease는 기존 관리 mutex 안에서 검증된 같은 staging 디렉터리의 게시만 재시도하며,
총 대기 시간은 최대 150 ms입니다. World 작업이나 사용자 결정을 반복하지 않으며,
점유되거나 변경된 경로를 덮어쓰지 않습니다. 재시도를 소진하면 저장된 승인은
보존하고 운영 실패를 알립니다.

이후 source 변경은 과거 온보딩 결정을 지우지 않습니다. 현재 World evidence를 사용할
수 없거나 stale이면 읽기 전용 status는 `ready_world_changed`를 보고합니다.
명시적 refresh가 현재 Canon과 온보딩 decision projection을 검증하면 과거 승인
snapshot ID를 바꾸거나 다시 승인받지 않고 준비 상태로 돌아옵니다. 변경 없는
refresh도 준비 상태를 유지합니다. World base가 없으면 명시적 `world-index`로
재구축하고, 기존 base가 stale이면 `world-refresh`를 사용합니다.
Status는 어느 작업도 암묵적으로 실행하지 않습니다.

읽기 전용 MCP tool `lode_onboarding_status`는 state pointer, Session record, storage
selection, current candidate set, successor-producing ReviewDecision, 최신 phase-appropriate
ReviewDecision, Product Model revision, Product Canon identity 및 World Model freshness를
검증합니다. review 대기 중인 후속 candidate에서는 producer도 latest decision입니다.
`ready` 또는 `rejected`에서는 latest decision이 current successor를 직접 review하고
일치하는 acceptance 또는 rejection disposition을 가져야 합니다. 별도의
`lode_onboarding_review` transaction은 정확한 current candidate-set identity에 대한
사용자 작성의 명시적 disposition만 수락하고, 모든 promotion check를 Core에 위임합니다.

## Temporal graph projection

현재 World snapshot은 온보딩을 temporal provenance protocol `0.15.0`으로
project합니다. Candidate set은 정확한
source evidence와 연결되고, candidate는 Evidence 및 별도의 proposed product-concept
reference와 연결되며, ReviewDecision은 accepted, rejected, revised 및 promotion outcome을
보존합니다. revise decision에는 후속 candidate set으로 향하는 명시적 `PRODUCES` edge가
있습니다. 이후 accepted decision은 변경 불가능한 previous/resulting ProductModelRevision
receipt에 별도로 연결되고, resulting receipt는 promoted candidate identity로 다시
연결됩니다.

Opaque historical candidate reference는 bounded ID와 digest만 노출하며 fresh current
candidate에는 `HISTORICALLY_FOLLOWS`로만 연결됩니다.

이 graph는 audit 및 traversal projection이지 decision source가 아닙니다. source
ReviewDecision이 사용자의 promotion authority를 기록하더라도 project된 모든 node와 edge의
instruction/promotion flag는 false입니다. 정상 traversal은 CandidateSet, candidate,
Evidence, Unknown 및 proposed-concept node를 숨깁니다. 사용자는
`world-temporal --include-candidates true` 또는 MCP
`include_unreviewed_candidates: true`로 이를 명시적으로 검사할 수 있습니다. Context
Compiler는 이 option을 절대 활성화하지 않습니다. review된 decision 및
ProductModelRevision receipt는 정상 reviewed traversal에서 계속 사용할 수 있습니다.

다음 명령으로 dependency-free verifier를 실행하세요.

```powershell
npm run verify:onboarding
```

이 verifier는 기존 코드, 새 프로젝트 brief, 빈 evidence, revision 후 acceptance,
selection 또는 rejection, phase-aware producer/latest review lineage, deterministic restart,
candidate/review/promotion graph projection, 기본 candidate exclusion, 명시적 candidate
traversal, graph 및 artifact tampering, pre-existing canon, stale source, secret rejection,
legacy migration, 읽기 전용 status MCP, 그리고 Git, GraphDB 또는 Go binary 없이 작동하는
경우를 다룹니다. `npm run verify:conversational-onboarding`은 typed conversation-native
`revise -> guide -> accept -> guide` vertical을 별도로 입증합니다.

## 명시적으로 연기됨

- 실행된 live prepared-query evaluation, compare-and-swap publication 및 non-ArcadeDB transport
- 명시적 structured brief 범위를 넘어서는 dedicated imported-backlog connector
- 별도의 Feature/code/test mapping review scope를 넘어서는 general relationship promotion
- automatic semantic promotion, document synchronization 및 merge/conflict resolution

## 선택적 무결성 오류와 후보 복구

알려진 Product/World/Graph 무결성 오류는 기존 readiness와 Attention에 표시하며, 정상 Core 진입·대화 복구·일반 작업을 차단하지 않습니다. 해당 Product 작업의 엄격한 근거 검증은 유지합니다. Lode가 진단을 맡으며 사용자에게 복구 양식을 작성하게 하지 않습니다.

손상되거나 누락된 후보의 검증된 원본이 있으면 `lode_onboarding_candidate_restore`(CLI `onboarding-candidate-restore`)를 사용합니다. Lode가 정확한 Project/후보 식별자·원본 내용·관찰한 raw digest를 전달합니다. 작업은 손상 바이트를 recovery custody에 보존하고 동시 변경을 검사한 뒤 정확한 대상만 원자적으로 교체합니다. canonical content가 같아도 raw bytes가 동일하다는 뜻은 아닙니다. 복원은 승인·Canon 변경·P2 방향을 만들지 않습니다.

원본이 없으면 손상된 현재 후보 중 미승인·다른 후보의 참조 대상이 아닌 경우에만 기존 semantic refresh의 `recoveryBasis`를 사용합니다. Lode가 새로운 근거 연결 제안을 작성하며 Core는 의미를 추론하거나 과거 승인을 승계하지 않습니다. 보존 위치로 옮기기 전에 Canon과 계보 사전조건을 검사합니다. 손상 바이트는 digest 주소의 custody에 남고, 실패 시 포인터가 그대로이며 원래 경로가 비어 있을 때만 복원합니다. 프로세스 중단 후에는 같은 pointer/raw basis를 다시 전달해 해당 custody를 정확히 복구하고 재개합니다. 다른 파일·후속 포인터·새 편집은 롤백하지 않습니다. 검토된 후보는 의미 대체가 아니라 정확한 원본 복원이 필요합니다.

<a id="product-cli-examples"></a>

## Product CLI 예제

### 대화 우선 경로

번들 `lode-agent-onboarding` Skill은 Product 온보딩의 권장 대화형 진입점입니다.
현재 상태를 검사하고 저장소 범위나 저장 방식처럼 중요한 선택만 질문합니다.
범위가 정해진 최신 근거를 읽고 Core 검증용 제안을 제출한 뒤, 근거가 연결된
후보를 보여줍니다. Product Canon을 바꾸기 전에는 명시적 검토를 거칩니다.
이 Skill은 `product` 프로필을 명시적으로 선택하며 공급자의 제안은 P3 근거로 남습니다.

### 선택적 Product 프로필 CLI 경로

동일한 프로젝트 및 Lode Session 식별자를 초기화하거나 재개합니다.

```powershell
lode-agent init C:\path\to\project --runtime claude,codex,opencode --profile product
lode-agent onboarding-status C:\path\to\project
```

구조화된 사용자 설명이 없으면 처음 실행은 `awaiting-evidence`를 반환합니다.
Core는 심볼 이름에서 제품 개념을 만들어 내지 않습니다. 대화 Skill은 최신 근거에
따른 의미 제안을 제출하며, CLI 사용자는 같은 `semanticProposal`을 `--input`에
넣을 수 있습니다. Core가 정확한 SourceSnapshot, 경로, 줄, 선택적 심볼과 Product
Model 참조를 검증한 뒤 변경 불가능한 후보 집합 ID를 반환합니다. 검토 전에 내용을 확인하세요.

```powershell
$onboarding = lode-agent onboarding-status C:\path\to\project | ConvertFrom-Json
lode-agent onboarding-candidates C:\path\to\project `
  --candidate-set $onboarding.state.candidateSetId
```

증거를 검토한 뒤에만 `onboarding-review.json`을 만드세요. 아래의 간단한
예시는 전체 부트스트랩 후보를 승인합니다. 이름 변경, 분리, 병합 또는 제외할
후보가 있다면 선택 승인이나 수정이 더 안전합니다.

```json
{
  "candidateSetId": "onboarding-candidates-<id>",
  "disposition": "accept-all",
  "rationale": "I reviewed every evidence-linked candidate and adopt this bootstrap batch."
}
```

결정을 적용하고 생성된 뷰를 검증합니다.

```powershell
lode-agent onboarding-review C:\path\to\project --input .\onboarding-review.json
lode-agent graph-query C:\path\to\project --query "<task>"
lode-agent world-status C:\path\to\project
lode-agent context-preview C:\path\to\project `
  --task "Find implementation evidence for one reviewed Feature" --budget 32768
lode-agent world-docs-build C:\path\to\project
lode-agent resume C:\path\to\project --runtime claude,codex,opencode --profile product
```

`accept-all`은 전체 후보를 직접 확인한 경우 사용할 수 있지만 기본 권장
방식은 아닙니다. 검토에서는 의존성이 완전한 일부 후보를 승인하거나, 후보
집합을 수정·거부하거나, 추가 증거를 요청하거나, 미해결 개념을 명시적인
Unknown으로 남길 수 있습니다. 전체 계약은
[온보딩 문서](onboarding.md)를 참고하세요.

### 소스 범위

생성 결과물, 벤더 의존성, 복사된 프로젝트, 대형 픽스처 또는 모델 번들이
포함된 저장소에서는 첫 인덱싱 전에 프로젝트 기준 관찰 경계를 정의하세요.

```json
{
  "mode": "existing",
  "sourceScope": {
    "includeRoots": ["src", "packages"],
    "excludeRoots": ["dist", "vendor", "generated", "fixtures"]
  }
}
```

`lode-agent init ... --profile product --input .\onboarding.json`으로 전달합니다. Source Scope는
관찰 범위만 제어합니다. Product Canon을 정의하거나 후보를 승인하거나 실행
권한을 부여할 수 없습니다.

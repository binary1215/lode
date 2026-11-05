> 이 문서는 [Delivery state observation](../delivery-observation.md)의 한국어판입니다.

# 전달 상태 관측

상태: 프로토콜 `0.1.0`에 따른 공급자 중립 P3 이벤트 계약과 비지속 P4 현재/이력 프로젝션이 구현되어 있습니다.

## 목적과 경계

전달 상태는 Product Canon이나 릴리스 승인보다 좁은 운영 질문에 답합니다. **어떤 아티팩트 리비전이 어떤 환경의 어떤 대상에서 어떤 명시적 순서로 관측됐는가?** Git 유무와 무관하게 동작하며 배포, polling, 승인 또는 성공 판정을 수행하지 않습니다.

Host가 보고한 각 이벤트는 `delivery.state` 타입의 불변 공통 `ObservationRecord`가 됩니다. `DeliveryStateProjection`은 읽을 때 계산합니다. 어느 아티팩트도 Product Canon을 변경하거나 `ReviewDecision`을 만들거나 P2 복구 방향을 쓰거나 일반 작업을 막지 않습니다. 제품별 CI, 배포, 장치, analytics 및 credential 처리는 Host adapter에 남습니다.

이 기능은 [Release observation](release-observation.md)을 대체하지 않고 보완합니다. Release observation은 도달 가능한 Git commit, 현재 ref 및 별도로 보고된 승인을 검증합니다. Delivery observation은 대상별 적용, 실패 및 rollback 이력을 릴리스로 해석하지 않고 보존합니다.

## 이벤트 계약

```json
{
  "environmentKey": "environment-a",
  "targetKey": "target-one",
  "artifactKey": "service.public-api",
  "revisionKey": "v2",
  "revisionDigest": "<sha256>",
  "outcome": "applied",
  "sequence": 1,
  "predecessorObservationId": "observation-<24 hex>",
  "rollbackTargetObservationId": null,
  "observedAt": "2026-09-01T00:00:00.000Z",
  "sourceScopeDigest": "<sha256>",
  "sourceEventKeyDigest": "<sha256>",
  "sourceEvidenceDigest": "<sha256>",
  "revisionReference": {
    "worldModelId": "world-model-<24 hex>",
    "revisionId": "file-revision-<24 hex>",
    "sourcePath": "revisions/v2.txt",
    "digest": "<sha256>"
  }
}
```

`outcome`은 `applied`, `failed`, `cancelled`, `rolled-back` 중 하나입니다. rollback은 `rollbackTargetObservationId`로 이전의 정확한 applied observation을 지정합니다. 선택적 `revisionReference`는 전부 제공하거나 전부 생략합니다. 제공하면 Core는 어떤 것도 기록하기 전에 보존된 World snapshot, 정확한 `FileRevision`, path 및 digest를 검증합니다. 생략하면 revision은 명시적으로 `declared`에 머뭅니다. Host가 제공한 문자열을 검증된 저장소 revision으로 바꾸지 않습니다.

`delivery.state`는 검증된 binding이 `AT_REVISION` graph claim을 만들기 때문에 Core가 소유하는 specialization입니다. 일반 `lode_observation_ingest`와 일반 registered adapter는 이 예약 타입을 거부합니다. Host는 전용 `lode_delivery_observe`를 사용하며, 전용 writer가 persistence 경계에서 동일 Project의 보존된 World를 다시 대조합니다. 이는 사용자 승인 gate가 아니라 proof-integrity 경계입니다. custom Observation type은 계속 열려 있고 declared delivery revision도 전용 호출로 받아들입니다.

Replay는 공통 exact adapter/version/source-scope/source-event key를 사용합니다. 동일 replay는 수렴하고 내용이 다르면 이전 이벤트를 대체하지 않고 실패합니다.

## 현재 상태 재구성

현재 상태는 수신 시각이나 파일명 순서로 선택하지 않습니다. 정확한 환경, 대상 및 artifact별로 명시적 nonnegative `sequence`와 exact predecessor chain을 검증합니다. 따라서 한 대상의 독립적인 artifact가 서로의 현재 상태를 덮거나 잘못된 mixed-version 결과를 만들지 않습니다.

- sequence 0의 root 하나
- sequence당 record 하나
- 이후 record가 정확한 직전 sequence를 가리킴
- predecessor당 successor 하나
- rollback이 같은 대상 이력의 이전 applied 또는 rolled-back 이벤트를 가리킴

누락, 중복, 분기 또는 비연속 순서가 있으면 해당 artifact-target history는 `unknown`이 되고 bounded issue record가 공개됩니다. Core는 최신 이벤트를 추측하지 않습니다. 실패 또는 취소 시도는 `lastAttempt`에 나타나지만 가장 최근의 applied 또는 rolled-back revision을 덮지 않습니다. 환경은 artifact별 **관측된** 대상 사이에서 `uniform`, `mixed`, `unknown`으로 판정한 뒤 보수적으로 요약됩니다. Core는 제품별 대상 inventory를 모르므로 항상 `deploymentCompleteEstablished: false`와 `unobservedTargetsInferred: false`를 보고합니다.

기본 읽기는 최대 100개의 이력 이벤트와 정확한 total/omission을 반환합니다. 호출자는 store 전체 상한인 4,096까지 요청할 수 있습니다. 이 방식은 이력을 삭제하거나 ingestion gate를 추가하지 않으면서 일반 status를 읽기 쉽게 유지합니다.

## Graph 계보

검증된 revision binding은 `ObservationRecord -[:AT_REVISION]-> FileRevision`을 추가합니다. 정확히 검증된 revision이 현재 source snapshot이 아니라 과거 revision이면 P4 graph는 보존된 World identity, logical file identity, path 및 digest를 가진 derived `RevisionReference`를 만듭니다. declared-only revision에는 `AT_REVISION` edge를 만들지 않습니다. Graph 검증은 누락되거나 불일치하는 verified edge를 거부합니다.

Graph는 계속 재구축 가능한 view입니다. GraphDB 또는 materialized graph를 삭제해도 delivery record를 지우거나 현재 전달 의미를 변경할 수 없습니다.

## CLI와 MCP

```text
lode-agent delivery-observe <project> --input <delivery-observation.json>
lode-agent delivery-status <project> [--environment <key>] [--target <key>] [--history-limit <1..4096>]
```

- `lode_delivery_observe`
- `lode_delivery_status`

Typed observation call은 의도적으로 사용자 확인 checkbox를 추가하지 않습니다. 비권위 Host evidence만 기록하며 배포 또는 제품 권한을 부여하지 않기 때문입니다. Trusted Host composition이 구조화 이벤트를 구성하고, 일반 사용자는 간결한 status card를 보거나 Lode에 환경 또는 대상을 질문하면 됩니다.

## 수락 속성

- 두 환경이 서로 다른 현재 revision을 표시해도 서로 덮어쓰지 않습니다.
- 한 대상의 독립적인 artifact는 독립적인 ordering과 current state를 유지합니다.
- 한 대상만 부분 적용되면 환경은 complete가 아니라 `mixed`가 됩니다.
- 실패 시도는 마지막 applied 상태를 보존합니다.
- rollback은 후속 이력을 삭제하지 않고 새 불변 이벤트가 됩니다.
- 순서가 없거나 충돌하면 receive-time 추측 대신 `unknown`이 됩니다.
- 관측되지 않은 대상은 성공으로 추론되지 않습니다.
- 보존된 exact source revision은 기계적으로 검증되어 graph와 연결되고 declared reference는 그대로 공개됩니다.
- 일반 Observation input은 예약된 verified delivery binding을 자기 선언할 수 없습니다.
- P1 Product Canon, P2 recovery 및 ReviewDecision byte는 변경되지 않습니다.
- CLI와 MCP는 같은 Core projection identity를 반환합니다.

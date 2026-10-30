> 이 문서는 [feature-mapping.md](../feature-mapping.md)의 한국어판입니다. 코드, 명령, 프로토콜 식별자와 필드 이름은 원문 표기를 유지합니다.

# 검토 게이트가 적용된 Feature 매핑

이 권위 경계를 변경하기 전에 [`architecture.md`](architecture.md)와
[`authority-plane-contract.md`](authority-plane-contract.md)를 읽으세요.

## 검토 전 증거 정리

Lode는 후보마다 사용자에게 묻지 않고 제안을 조사하고 묶어 제시할 수 있습니다.
검토되지 않은 대기 배치가 오래되면 기존 제안 API에 `expectedCandidateSetId`와
최신 의미 제안을 전달합니다. CLI는 `--expected-candidate-set`, MCP는
`expected_candidate_set_id`를 사용합니다. 공유 변경 잠금 안에서 이전 원본과
저장된 검토 파일을 검증하며, 이미 저장된 사용자 결정·손상된 검토·잘못된 대기 ID·
오래된 새 증거가 있으면 쓰기 전에 거부합니다. 과거 후보와 검토된 관계는 보존하며,
거절·승인·P2 방향을 만들어 내지 않습니다. 관계 승격에는 여전히 명시적 사용자
검토가 필요합니다.

## 계약

Feature 매핑 프로토콜 `0.2.0`은 Core 코드 분석이 관련성이나 승인된 제품 관계를 만들어 내도록 허용하지 않으면서, 권위 있는 `Feature` 및 `Capability` 개념을 관찰된 `File`, `Symbol`, `Test` 엔터티에 연결합니다.

정규 방향은 다음과 같습니다.

```text
File or Symbol -[:IMPLEMENTS]-> Feature or Capability
Feature or Capability -[:VERIFIED_BY]-> Test
```

provider Lode는 현재 프로젝트 증거를 읽은 뒤 매핑을 제안할 수 있습니다. Core는 불변 `FeatureMappingCandidateSet`을 만들기 전에 제안 스키마, 정확한 현재 엔드포인트 ID와 리비전, 관계 방향, source 및 product snapshot 바인딩, 범위가 제한된 신뢰도, 설명, 콘텐츠 주소 기반 Evidence를 검증합니다. Candidate 및 Evidence 레코드의 지시 권위와 승격 권위는 false입니다. 의미 제안이 없으면 Core는 명시적 Unknown을 기록하고 candidate를 만들지 않습니다.

사용자가 명시적으로 작성한 매핑 `ReviewDecision`은 모든 candidate를 수락하거나, 이름이 지정된 선택 항목을 수락하거나, 배치를 거부할 수 있습니다. 수락은 candidate를 변경하지 않습니다. 대신 candidate에는 `PROMOTED_FROM`으로, decision에는 `PRODUCES`로 연결된 별도의 `ReviewedRelationship` receipt를 생성한 다음, 검토된 정규 `IMPLEMENTS` 또는 `VERIFIED_BY` edge를 구체화합니다. 거부는 `REJECTED_BY`를 기록하며 정규 매핑 edge를 생성하지 않습니다.

매핑 검토는 Product Canon을 수정하지 않습니다. 모든 검토는 정확한 현재 candidate set과
검증된 digest를 요구하며, 활성 Run이나 검토 대기 Run이 없어야 합니다. 수락에는
제안과 일치하는 최신 저장소·Product evidence도 필요합니다. 사용자의 명시적 거절은
source나 Product evidence가 변경된 후에도 그 정확한 candidate set을 종료할 수
있지만 관계를 승격하지는 않습니다.

거절은 불변 제안과 당시 바인딩을 보존하고, 파생 graph에는 검증된 현재 Product
identity를 사용합니다. World가 검증 가능한 stale 상태라면 같은 명시적 거절 작업
안에서 계보를 보존하며 갱신합니다. World가 없으면 명시적 재구축이 필요하며,
손상된 World는 무결성 오류이지 덮어쓸 권한이 아닙니다. 거절 후 Lode는
소스를 되돌리거나 상태 파일을 수동 삭제하지 않고 현재 증거로 대체 제안을 만들 수
있습니다. Drift나 새 제안 시작 요청만으로 사용자 거절을 생성하지 않으며, 기존에
검토된 관계 기록도 보존합니다.

불변 P1 ReviewDecision은 재구축 가능한 P4 World 투영보다 먼저 기록됩니다. 결정은
저장됐지만 투영이나 마지막 workflow pointer 게시가 중단됐다면, 정규화된 같은 검토
요청은 저장된 결정을 검증한 뒤 누락된 파생 view만 재구축하고 pointer를 완료합니다.
이는 기존 결정의 복구이지 새 승인이 아닙니다. 이후 source drift는 그대로 알리며,
결정을 고치거나 재승인을 요청할 이유로 삼지 않습니다. P1 기록 전 실패는 결정
투영을 게시할 수 없습니다. 같은 candidate set에 대한 다른
disposition·선택·rationale은 refresh나 게시 전에 거부합니다. 상충하는 저장 결정이
여러 개여도 하나를 선택하거나 삭제하지 않고 오류로 처리합니다.

이전 게시 순서가 중단돼 P1 결정 없이 P4 투영만 남은 상태와의 호환 복구에서는,
현재의 명시적 검토 요청만 P1 결정의 근거로 사용할 수 있습니다. 그 요청의 정확한
결정 ID가 이미 투영돼 있고 repository evidence, Product identity 및 모든 비파생
freshness 신호가 candidate set과 그대로 일치할 때에만 복구합니다. Graph 사본은
비교 증거일 뿐 P1 결정의 출처가 아닙니다. 변경된 요청, 실제 source·Product drift,
부분적이거나 불일치하는 투영은 fail closed됩니다. 제안·검토 쓰기는 기존 Session
변경 조정 장치를 함께 사용합니다. 읽기 전용 status는 상태를 바꾸지 않고 새 사용자
결정을 요구하지 않은 채 남은 복구를 보여줍니다. 완료 후에도 같은 현재 candidate에
대한 동일 요청은 저장된 프로젝트 기록을 바꾸지 않고 검증된 기존 결과를 반환합니다.
검토된 묶음을 다시 열거나 더 새로운 candidate pointer에 과거 요청을 적용할 수
있다는 뜻은 아닙니다.

제안을 시작할 때 검증된 현재 World를 재사용하며, 계보를 비워 재구축하지 않습니다.
매핑 파생 투영을 게시할 때도 현재 source와 revision 계보를 보존합니다. 따라서 게시
자체가 유효한 제안을 stale로 만들지 않습니다. 실제 source·Canon·endpoint drift에는
여전히 새로운 증거가 필요하며, 과거 승인이나 제출된 제안을 고쳐 맞추지 않습니다.

의미 제안 없이 명시적으로 설정을 시작하면 같은 작업 안에서 없는 World를 구축하거나
검증된 stale World를 새로 고칠 수 있습니다. 기존 evidence/Unknown 묶음만 만들며,
매핑을 추론하거나 사용자 결정을 생성하지 않습니다. 읽기 전용 status는 이 설정을
실행하지 않습니다.

## 명령

```text
node scripts/lode.mjs feature-mapping-start <project> --input <semantic-mapping-proposal.json>
node scripts/lode.mjs feature-mapping-status <project>
node scripts/lode.mjs feature-mapping-candidates <project> --candidate-set <feature-mapping-candidates-id>
node scripts/lode.mjs feature-mapping-review <project> --input <mapping-review.json>
node scripts/lode.mjs feature-mapping-review-read <project> --review <feature-mapping-review-decision-id>
```

의미 제안 입력 예시는 다음과 같습니다.

```json
{
  "schemaVersion": 1,
  "sourceSnapshotId": "source-snapshot-<24-hex>",
  "productModelId": "product-model-<24-hex>",
  "candidates": [
    {
      "relationshipType": "IMPLEMENTS",
      "sourceNodeId": "symbol-<24-hex>",
      "productNodeId": "feature-<24-hex>",
      "explanation": "The implementation behavior and the approved Feature contract match.",
      "confidence": 0.9
    }
  ]
}
```

수락 입력 예시는 다음과 같습니다.

```json
{
  "candidateSetId": "feature-mapping-candidates-<24-hex>",
  "disposition": "accept-selection",
  "acceptedCandidateIds": ["feature-mapping-candidate-<24-hex>"],
  "rationale": "Reviewed repository and test evidence supports this product relationship."
}
```

`accept-all`은 `acceptedCandidateIds`를 무시하고, `reject`는 아무것도 수락하지 않습니다. CLI 검토와 타입이 지정된 MCP `lode_feature_mapping_review`는 동일한 Core 변경을 호출하며, MCP는 추가로 `confirm_user_review: true`를 요구합니다. MCP는 `lode_feature_mapping_propose`와 읽기 전용 `lode_feature_mapping_status`도 노출합니다. `include_unreviewed_candidates`를 명시적으로 활성화하지 않는 한 일반 temporal traversal은 검토되지 않은 candidate 표면을 제외합니다.

## 저장 및 프로젝션

로컬 적합성 경로는 다음을 저장합니다.

```text
.lode/feature-mappings/current.json
.lode/feature-mappings/candidate-sets/feature-mapping-candidates-*.json
.lode/feature-mappings/review-decisions/feature-mapping-review-decision-*.json
```

Candidate set과 ReviewDecision은 불변이며 digest로 검증되는 artifact입니다. `current.json`은 digest로 검증되는 workflow pointer일 뿐입니다. temporal graph와 World Model은 계속 재구축 가능한 프로젝션이며, Git과 GraphDB는 선택 사항이고 매핑 권위에 관여하지 않습니다.

이전에 검토된 엔드포인트가 사라지면 과거 receipt는 stale freshness 상태로 남고, 현재 정규 edge는 생략됩니다. 새 현재 매핑을 확립하려면 이후의 의미 제안과 명시적 검토가 필요합니다.

## 의미 제안 경계

Core는 이름, 경로, token overlap 또는 저장소 특화 어휘에서 제품 의미를 추론하지 않습니다. provider Lode가 의미를 읽고 범위가 제한된 관계만 제안하며, Core는 현재 증거 검증, 결정론적 정규화, 불변 저장, drift 검사, 검토 게이트를 소유합니다. 잘못되거나 stale인 제안은 fail closed됩니다. 어휘 fallback은 없습니다.

provider-neutral live proposal orchestration, change-impact candidate, 대량 사용자 편집/revision batch, 자동 mapping refresh, 일반적인 relationship-promotion 정책은 향후 과제로 남아 있습니다.

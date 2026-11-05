> 이 문서는 [document-change-review.md](../document-change-review.md)의 한국어판입니다. 코드, 명령, 프로토콜 식별자와 필드 이름은 원문 표기를 유지합니다.

# 문서 변경 검토와 적용

상태: 활성 알파 계약

프로토콜 버전: `0.1.0`

적용 영수증은
[`AuthorityPlaneContract`](authority-plane-contract.md)에 따른 P3 증거입니다. 적용된 Product Canon
자식 GraphSnapshot은 그 영수증이 생기기 전에 빌드되므로, 해당 스냅샷에는
영수증이 포함되지 않아야 합니다. 이후 감사 자식만 영수증을 포함할 수 있습니다. Core는
변경된 그래프 식별자, 부모 SourceSnapshot, 동일 스냅샷에서의 제외, 자식에서의 포함을 검증하고
인과적 자기 참조를 거부합니다.

## 목적

생성된 Markdown은 검증된 `GraphSnapshot`을 사람이 읽을 수 있도록 결정적으로 프로젝션한 것입니다. 따라서 편집된 페이지는 제안된 제품 변경의 증거이지, 새로운 권한 출처가 아닙니다. 이 계약은 누락되어 있던 명시적 전이를 제공합니다.

```text
edited generated Markdown
  -> immutable DocumentChangeCandidateSet
  -> explicit user ReviewDecision
  -> exact complete Product Model revision
  -> verified Product Canon write
  -> child SourceSnapshot and GraphSnapshot
  -> reconciled deterministic Markdown
  -> immutable application receipt
  -> later audit SourceSnapshot and GraphSnapshot
```

어떤 Markdown 파서나 모델도 편집된 산문에서 권한 있는 Product Model을 추론할 수 없습니다. 수락 검토에는 사용자가 선택한 완전한 구조의 `resultingProductModel`이 포함되어야 합니다.

## 권한 경계

`DocumentChangeCandidateSet`과 각 후보는 instruction authority와 promotion authority가 모두 false인 불변 증거로 유지됩니다. 검토 후에도 이들을 다시 분류하지 않습니다.

수락 `ReviewDecision`은 다음을 갖습니다.

- `decisionScope: document-to-product-canon`;
- `authority: explicit-user-document-change-review`;
- `instructionAuthority: true`;
- `promotionAuthority: true`;
- 수락 및 거부 후보 식별자의 정확한 분할;
- 후보, DocumentProjection, GraphSnapshot, SourceSnapshot, 이전 Product Model 및 결과 Product Model 식별자;
- 필수 사용자 근거.

거부 역시 명시적인 사용자 ReviewDecision이지만, `promotionAuthority: false`이며 결과 Product Model이 없습니다.

적용 영수증은 발생한 일을 보여 주는 증거입니다. 그 자체에는 독립적인 instruction authority나 promotion authority가 없습니다.

## 검토 입력

CLI는 엄격한 JSON 객체를 받습니다.

```json
{
  "candidateSetId": "document-change-candidate-set-...",
  "disposition": "accept-all",
  "acceptedCandidateIds": [],
  "resultingProductModel": {
    "schemaVersion": 1,
    "featureGroups": [],
    "capabilities": [],
    "features": [],
    "requirements": [],
    "constraints": [],
    "decisions": []
  },
  "rationale": "Explicit user rationale",
  "apply": true
}
```

지원하는 disposition은 `accept-all`, `accept-selection`, `reject`입니다.

- `accept-all`은 명시적인 `acceptedCandidateIds` 목록을 허용하지 않으며 전체 후보 집합을 수락합니다;
- `accept-selection`은 비어 있지 않은 고유 부분 집합을 요구하며 나머지를 거부합니다;
- `reject`는 수락 후보와 결과 Product Model을 허용하지 않습니다;
- 수락 disposition은 현재 Canon과 다른 완전한 Product Model을 요구합니다;
- `apply`의 기본값은 `true`입니다. `false`는 나중에 명시적으로 적용해야 하는 검토를 기록합니다.

전체 대상 모델을 요구하는 것은 의도적인 설계입니다. 이렇게 해야 임의의 Markdown 텍스트, 제목, 링크 또는 생성된 레이아웃이 암묵적인 Product Canon 패치가 되는 것을 막을 수 있습니다.

## 검증 및 실패 경계

검토를 기록하기 전에 구현은 다음을 검증합니다.

- 프로젝트가 준비되어 있고 활성 또는 검토 대기 중인 Run이 없음;
- 후보 집합 콘텐츠 식별자와 정확한 프로젝트 범위;
- 현재 게시된 바이트가 캡처한 제안과 여전히 일치함;
- 기준 DocumentProjection 및 GraphSnapshot이 계속 사용 가능하고 다이제스트가 유효함;
- 수락 검토가 후보 프로젝션에 사용된 것과 동일한 Product Canon을 여전히 대상으로 함;
- 완전한 결과 Product Model이 엄격한 키, 참조, 계층 및 순환 검증을 통과함;
- 하나의 후보 집합이 충돌하는 ReviewDecisions를 받을 수 없음.

적용 전에는 저장된 검토와 대상 Product Model 리비전을 검증하고, 검토 당시 Canon·정확한 승인 결과·무관한 후속 Canon을 구분합니다. 문서와 무관한 소스 드리프트는 여전히 조정이 필요하지만, 해당 승인 결과 때문에 바뀐 파생 입력은 재구축할 수 있습니다. 게시 파일은 검토된 변경 전 내용 또는 정확한 목표 내용만 허용하므로, 후속 사용자 편집을 덮어쓰지 않고 부분 게시를 재개합니다.

수락된 적용은 검토된 Product Model만 쓰고, 리비전 부모를 파생하며, 자식 SourceSnapshot 및 GraphSnapshot을 빌드하고 검증한 다음, 검토된 게시 드리프트를 해당 그래프에서 생성한 결정적 Markdown으로 교체합니다. 거부는 Canon을 변경하지 않습니다. 어느 결과이든 그 후에는 불변 영수증을 후속 감사 자식 GraphSnapshot에 프로젝션하고 결정적 Markdown 뷰를 해당 감사 그래프로 전진시킵니다.

영수증은 의도적으로 감사 전 적용 결과를 지칭합니다. 영수증을 포함하는 동일한 GraphSnapshot을 지칭할 수는 없습니다. 그렇게 하면 콘텐츠 해시 순환이 생기기 때문입니다. 이후 감사 그래프는 파생된 증거일 뿐이며, 불변 ReviewDecision과 적용 영수증이 권한 있는 전이 기록으로 남습니다.

실패해도 이미 반영된 승인 Canon을 롤백하거나 문서를 일괄 복원하지 않습니다. 부분 게시 뒤의 거부 결정을 포함해 같은 저장된 결정으로 남은 프로젝션을 재개하며 재승인을 요구하지 않습니다. 상태는 Canon 반영과 프로젝션 준비를 구분합니다. 좁은 P3 Evidence basis에는 검토 해시와 적용 전 World 식별자만 연결하고 승인이나 문서 본문을 복제하지 않습니다. 이 basis가 없는 과거 중단 작업도 검증된 검토 당시 그래프에서 재구성할 수 있습니다. 변경 전·목표 바이트는 기존 후보와 불변 목표 프로젝션을 재사용합니다. 후속 Canon·문서 포인터·다른 편집은 보존합니다. 과거 영수증은 과거 성공 증거이지 현재 프로젝션 준비 완료 주장이 아닙니다. Canon 교체는 고정 temporary path를 배타적으로 획득하며 부분 쓰기 실패 시 그 호출 소유 temporary만 제거합니다. 기존 `EEXIST` temporary는 보존합니다.

## 아티팩트

```text
.lode/document-changes/
  candidate-sets/<document-change-candidate-set-id>.json
  review-decisions/<document-change-review-decision-id>.json
  product-model-revisions/<product-model-id>.json
  applications/<document-change-application-id>.json
  application-bases/<document-change-review-decision-id>.json
```

적용 영수증은 다음을 결속합니다.

- ReviewDecision 및 CandidateSet 식별자와 해시;
- 이전 및 결과 Product Model 식별자와 해시;
- 이전 및 이후 World Model, SourceSnapshot 및 GraphSnapshot 식별자;
- 결과 DocumentProjection 식별자와 해시;
- Canon 변경 여부;
- `activeRunMutation: none`.

모든 의미론적 식별자는 콘텐츠에서 파생됩니다. Git 커밋, 브랜치, GraphDB 레코드 ID, 공급자 세션, 파일시스템 위치 및 타임스탬프는 식별자에 관여하지 않습니다.

## CLI

```text
lode-agent world-docs-review <project> --input <review.json>
lode-agent world-docs-apply <project> --review <document-change-review-decision-id>
lode-agent world-docs-review-status <project> --candidate-set <document-change-candidate-set-id>
lode-agent world-docs-review-read <project> --review <document-change-review-decision-id>
lode-agent world-docs-application-read <project> --application <document-change-application-id>
```

## 읽기 전용 MCP

```text
lode_document_change_review_status
lode_document_change_review
lode_document_change_application
```

MCP는 검토를 기록하거나 적용할 수 없으며, Canon을 쓰거나, 그래프를 다시 빌드하거나, 문서를 게시할 수 없습니다.

## 명시적으로 보류된 항목

- 산문에서 구조화된 Product Model 변경을 의미론적으로 추출하는 기능;
- 자동 승인 또는 적용;
- 양방향 문서 동기화 및 충돌 해결;
- Obsidian 및 Notion 게시 어댑터;
- 원격 GraphDB 구체화.

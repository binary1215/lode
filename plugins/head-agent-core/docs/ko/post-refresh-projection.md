> 이 문서는 [post-refresh-projection.md](../post-refresh-projection.md)의 한국어판입니다. 코드, 명령, 프로토콜 식별자와 필드 이름은 원문 표기를 유지합니다.

# 갱신 후 Markdown 프로젝션 정책

상태: 활성 알파 계약

프로토콜 버전: `0.1.0`

관련 프로토콜:

- 증분 갱신: `0.2.0` (`0.1.0` 영수증은 계속 읽을 수 있음);
- 갱신 트리거: `0.2.0` (`0.1.0` 배치 및 전달 기록은 계속 읽을 수 있음);
- `DocumentProjectionAdapter`: `0.1.0`.

## 목적

`PostRefreshProjectionPolicy`는 한 가지 운영 선택을 제어합니다. 검증된 관찰 상태 갱신이 새 World Model과 GraphSnapshot을 커밋한 후 결정적 Markdown 프로젝션을 다시 생성할 수 있는지를 결정합니다. 이것은 Product Canon, 그래프 사실, 지시 출처 또는 promotion authority가 아닙니다.

유효 기본값은 `manual`입니다. 자동 생성은 명시적 사용자 명령이 불변 `automatic` 정책을 기록하고 정책 포인터를 전진시킨 후에만 시작됩니다.

```json
{
  "mode": "automatic"
}
```

정책 아티팩트는 콘텐츠에서 파생됩니다. 동일한 모드를 다시 선택하면 동일한 정책 식별자가 생성됩니다. 가변 포인터는 현재 운영 정책을 선택하지만 World Model, GraphSnapshot, DocumentProjection, ContextCapsule, ChangeSet 또는 execution-lineage 아티팩트의 식별자를 변경하지 않습니다.

## 순서가 정해진 갱신 경계

자동 경로는 검증된 관찰 상태 재구축보다 계속 하류에 있습니다.

```text
exclusive project World Model writer lease
  -> read effective post-refresh policy
  -> inspect the published Markdown view against the base GraphSnapshot
  -> capture edited pages as immutable candidates when safe
  -> execute and verify incremental refresh
  -> atomically advance the World Model and graph projection pointers
  -> apply or defer the Markdown projection policy
  -> persist PostRefreshProjectionReceipt
```

증분 갱신 영수증은 그 핵심 작업이 문서를 다시 생성하지 않았음을 기록합니다. 별도의 갱신 후 영수증은 정확한 갱신 요청 및 영수증, 정책, 이전/이후 World Model, SourceSnapshot 및 GraphSnapshot 식별자, 결과 DocumentProjection, 그리고 선택적 `DocumentChangeCandidateSet`을 연결합니다.

## 안전 disposition

정책은 다음과 같은 제한된 결과 중 하나를 생성합니다.

- `manual-deferred`: 안전한 기본값으로, 문서 검사나 게시가 발생하지 않음;
- `projected`: 새로운 결정적 프로젝션이 게시됨;
- `unchanged`: 현재 결정적 프로젝션이 이미 대상 그래프와 일치함;
- `blocked-edited-view`: 편집 내용이 현재 기준 그래프에 대해 캡처되었고 게시된 뷰는 보존됨;
- `blocked-stale-edited-view`: 편집된 뷰가 이미 이전 그래프를 기준으로 하며 명시적 해결을 위해 보존됨;
- `blocked-unmanaged-view`: 검증된 기준 프로젝션 없이 Markdown이 존재하며 보존됨;
- `failed`: Product Canon 또는 활성 실행 입력을 변경하지 않은 채 정책, 어댑터, 프로젝션 또는 영속성 검증에 실패함.

자동 모드는 편집되거나 관리되지 않는 Markdown을 절대 덮어쓰지 않습니다. 현재 편집된 뷰는 소스 갱신 전에 캡처되므로 후보 증거가 기준 콘텐츠를 생성한 정확한 GraphSnapshot에 계속 고정됩니다. 캡처 자체는 어떤 권한도 부여하지 않습니다. 이후 별도의 명시적 문서 변경 검토에서 그 집합을 거부하거나, 사용자가 제공한 완전한 Product Model이 있는 경우에만 수락할 수 있습니다. [`document-change-review.md`](document-change-review.md)를 참조하십시오.

정책의 다이제스트가 유효하지 않아도 관찰 상태 갱신은 계속 진행되며 갱신 후 결과는 `failed`가 됩니다. 유효하지 않은 정책은 검증된 World Model 전이를 막거나 변경함으로써 권한을 얻을 수 없습니다. 프로젝션 실패 역시 World Model 포인터를 롤백하지 않습니다. 생성된 뷰를 없음, 오래됨 또는 수정된 상태로 남기고 실패 이유를 기록합니다.

## 영속성

```text
.lode/document-projection/post-refresh/current-policy.json
.lode/document-projection/post-refresh/policies/post-refresh-projection-policy-<digest>.json
.lode/document-projection/post-refresh/current.json
.lode/document-projection/post-refresh/receipts/post-refresh-projection-receipt-<digest>.json
```

타임스탬프, PID, 어댑터 경로, 공급자 세션, Git 객체, GraphDB 레코드 또는 문서 공급자 페이지 ID는 정책이나 영수증 식별자에 관여하지 않습니다.

## CLI

```text
node scripts/lode.mjs world-docs-policy-set <project> --input <policy.json>
node scripts/lode.mjs world-docs-policy-status <project>
node scripts/lode.mjs world-docs-refresh-status <project>
node scripts/lode.mjs world-docs-refresh-read <project> --receipt <post-refresh-projection-receipt-id>
```

설정 명령은 `mode: manual|automatic`만 받습니다. 상태 및 영수증 명령은 읽기 전용입니다. 기존의 명시적 `world-docs-build`, `world-docs-status`, `world-docs-capture` 및 candidate-read 명령은 계속 사용할 수 있습니다.

읽기 전용 MCP는 다음을 노출합니다.

- `lode_post_refresh_projection_status`;
- `lode_post_refresh_projection_receipt`.

MCP는 갱신 후 정책을 변경하거나, 갱신을 트리거하거나, 문서 변경 후보를 검토하거나, 결정을 적용하거나, Canon을 변경할 수 없습니다. 별도로 타입이 지정된 `lode_markdown_projection_build` 작업은 자동 갱신 후 정책 밖에서 명시적인 결정적 문서 빌드를 수행할 수 있습니다. 읽기 전용 문서 검토 MCP 도구는 상태와 불변 아티팩트를 검사합니다.

## 권한 및 선택적 인프라

모든 정책과 영수증은 instruction authority와 promotion authority가 false이고, `canonMutation: none`이며, 활성 Run 변경이 없음을 선언합니다. 수락된 ContextCapsules와 ExecutionContracts는 기록된 그래프 식별자에 계속 고정됩니다.

이 프로토콜은 Git과 GraphDB를 참조하지 않습니다. 로컬 Markdown 어댑터가 적합성 경로입니다. 향후 GraphDB 프로젝션 갱신이 이 단계 전에 일어날 수 있고, 향후 Obsidian 또는 Notion 어댑터가 동일한 의미론적 프로젝션을 게시할 수 있지만, 어느 것도 로컬 완료에 필요하지 않습니다.

## 보류

- 문서 검토 영수증을 이후 GraphSnapshots에 프로젝션하는 기능;
- 자동 Obsidian 또는 Notion 게시;
- 양방향 문서 동기화 및 충돌 해결;
- 백그라운드 watcher 서비스 설치 및 공급자별 CI webhooks;
- 원격 GraphDB 프로젝션 전송.

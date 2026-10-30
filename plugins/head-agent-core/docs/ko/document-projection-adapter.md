# DocumentProjectionAdapter와 결정론적 Markdown 프로젝션

[영어 원문](../document-projection-adapter.md)

상태: 활성 알파 계약

프로토콜 버전:

- `DocumentProjectionAdapter`: `0.1.0`
- 결정론적 Markdown 렌더러: `0.1.0`
- `DocumentChangeCandidateSet`: `0.1.0`
- `PostRefreshProjectionPolicy`와 영수증: `0.1.0`
- 문서 변경 검토 및 적용: `0.1.0`

## 목적 및 권한 경계

`DocumentProjectionAdapter`는 검증된 하나의 시간적 `GraphSnapshot`을 결정론적인 사용자 대상 뷰로 변환합니다. 소스 방향은 다음과 같이 유지됩니다.

```text
User-owned Product Canon + observed code + verified lineage
  -> rebuildable GraphSnapshot
  -> verified DocumentProjection
  -> published Markdown view
```

프로젝션과 게시된 모든 Markdown 파일은 `derived-human-view-only`입니다. 이들은 재구축할 수 있고 고유 권한이 아니며, 지시 권한도 승격 권한도 없습니다. 사람이 문서를 편집하거나, 공급자가 호스팅하거나, 에이전트가 읽는다는 이유로 그 문서가 Product Canon이 되지는 않습니다. 물리적 경로, 어댑터 이름 및 향후 Obsidian 보관소 또는 Notion 페이지 ID는 `DocumentProjection` 의미적 ID의 외부에 남습니다.

## 활성 어댑터 계약

모든 어댑터는 다음을 구현해야 합니다.

- `describe()`;
- `readPointer()` / `writePointer()`;
- `readProjection(id)` / `writeProjection(id, projection)`;
- `listProjectionIds()`;
- `readPublishedDocuments()`;
- `publishDocuments(documents, options)`.

설명자는 다음을 선언해야 합니다.

```text
authority: derived-human-view-only
rebuildable: true
uniqueAuthority: false
instructionAuthority: false
promotionAuthority: false
publishedViewIsCanon: false
inboundEdits: document-change-candidates-only
```

코어는 누락된 메서드, 호환되지 않는 버전, 권한 주장, 변경된 불변 프로젝션, 변경된 렌더링 바이트, 다이제스트가 유효하지 않은 포인터, 안전하지 않은 상대 경로, 게시 트리의 심볼릭 링크 및 제한 크기 위반을 거부합니다.

## 결정론적 Markdown 모델

참조 렌더러는 입력 `GraphSnapshot`을 검증하고 노드와 엣지를 정규 순서로 정렬한 뒤 다음을 생성합니다.

- 정확한 Project, SourceSnapshot 및 GraphSnapshot ID와 노드/관계 요약을 포함하는 `index.md`;
- 의미적 노드 종류별로 그룹화된 청크 `nodes/*.md` 페이지;
- 정규 관계 유형별로 그룹화된 청크 `relations/*.md` 페이지;
- 관계 엔드포인트에서 해당 노드 페이지로 돌아가는 결정론적 노드 앵커 및 링크;
- 뷰가 파생되었고 권한이 없음을 알리는 명시적 경고.

모든 출력 문서는 불변 `DocumentProjection` 안에 상대 경로, 제목, 정확한 UTF-8 콘텐츠, SHA-256 콘텐츠 다이제스트 및 바이트 길이를 기록합니다. 콘텐츠로부터 파생된 프로젝션 ID에는 렌더러 프로토콜, GraphSnapshot ID, 모든 렌더링 콘텐츠, 요약 및 권한 플래그가 포함됩니다. 어댑터 종류와 물리적 위치는 제외됩니다. 렌더링 범위는 페이지당 500행, 문서 4,096개, 문서당 1 MiB 및 전체 64 MiB로 제한됩니다.

로컬 어댑터는 다음 위치에 저장합니다.

```text
.lode/document-projection/markdown/current.json
.lode/document-projection/markdown/snapshots/document-projection-<digest>.json
.lode/generated/knowledge/index.md
.lode/generated/knowledge/nodes/*.md
.lode/generated/knowledge/relations/*.md
```

스냅샷과 포인터는 검증 아티팩트입니다. `.lode/generated/knowledge/`는 교체 가능한 사용자 작업 뷰입니다. 포인터는 불변 프로젝션과 게시된 모든 문서가 성공적으로 검증된 후에만 전진합니다.

## 명시적 생성 및 정책 기반 생성

Markdown 생성은 계속 명시적으로 사용할 수 있습니다.

```text
node scripts/lode.mjs world-docs-build <project>
node scripts/lode.mjs world-docs-status <project>
```

`world-docs-build`에는 다이제스트 검증된 현재 World Model이 필요합니다. `world-docs-status`는 World Model 최신성, GraphSnapshot 바인딩, 불변 프로젝션 검증 및 게시 뷰 드리프트를 각각 보고합니다. 주요 상태는 다음과 같습니다.

- `not-materialized`: 포인터나 게시된 Markdown이 없습니다.
- `unmanaged`: 검증된 기준 프로젝션 없이 Markdown이 존재합니다.
- `current`: 프로젝션, 게시 바이트 및 현재 그래프가 일치합니다.
- `stale`: 프로젝션이 다른 GraphSnapshot에 속합니다.
- `source-stale`: 프로젝션은 저장된 그래프와 일치하지만, 인덱싱 후 작업 프로젝트가 변경되었습니다.
- `modified`: 게시된 뷰가 불변 기준 프로젝션과 다릅니다.

누락된 출력은 재생성할 수 있습니다. 다이제스트 불일치, 의미적 분기, 안전하지 않은 경로 또는 어댑터 권한 상승은 실패로 폐쇄됩니다. 더 새로운 검증된 그래프가 깨끗한 게시 뷰를 교체할 수 있지만, 코어는 수정된 뷰를 덮어쓰지 않습니다.

유효한 새로 고침 후 정책의 기본값은 `manual`입니다. 사용자가 명시적으로 선택한 `automatic` 정책은 증분 새로 고침이 World Model을 검증하고 전진시킨 후에만 동일한 결정론적 구체화를 호출할 수 있습니다. 정책은 새로 고침 전 기준 뷰를 검사하고, 현재 편집 내용을 불변 후보로 캡처하고, 이후 별도의 콘텐츠 파생 결과를 기록합니다. 유효하지 않은 정책 또는 프로젝션 상태는 관찰 상태 새로 고침을 중지하거나 재작성할 수 없습니다. [`post-refresh-projection.md`](post-refresh-projection.md)를 참조하십시오.

## 인바운드 편집은 후보입니다

게시된 Markdown이 불변 기준과 다르면 재생성은 `DOCUMENT_PROJECTION_UNREVIEWED_DRIFT`로 실패합니다. 사용자는 차이를 명시적으로 캡처할 수 있습니다.

```text
node scripts/lode.mjs world-docs-capture <project>
node scripts/lode.mjs world-docs-candidates <project> --candidate-set <document-change-candidate-set-id>
```

캡처는 `.lode/document-changes/candidate-sets/` 아래에 불변이며 콘텐츠로부터 파생된 `DocumentChangeCandidateSet`을 생성합니다. 추가, 수정 또는 제거된 각 경로는 정확한 기준/제안 콘텐츠와 다이제스트, 소스 프로젝션, GraphSnapshot 및 거짓 지시/승격 플래그를 기록합니다. 캡처 자체는 Product Canon, 그래프, 소스 코드 또는 실행 아티팩트를 변경하지 않습니다. 별도의 범위 지정 ReviewDecision은 세트를 거부하거나 완전하고 명시적인 Product Model과 함께 있을 때만 수락할 수 있습니다. [`document-change-review.md`](document-change-review.md)를 참조하십시오. 형식화된 MCP는 `lode_markdown_projection_build`를 통해 결정론적 Markdown 프로젝션을 명시적으로 빌드할 수 있으며, 읽기 전용 MCP 도구는 프로젝션, 후보, 검토 및 적용 상태를 검사합니다. 그래도 MCP는 인바운드 편집을 캡처하거나, 문서 변경 후보를 검토하거나, 문서 의사결정을 적용할 수 없습니다.

## 적합성 및 유보된 작업

`LocalMarkdownProjectionAdapter`는 영속 참조 구현입니다. `InMemoryMarkdownProjectionAdapter`는 비영속 적합성 구현입니다. `verifyDocumentProjectionAdapterConformance`는 두 어댑터에서 콘텐츠로부터 파생된 프로젝션 ID와 게시 콘텐츠 다이제스트가 동일함을 증명합니다.

다음 항목은 계속 유보됩니다.

- 문서 아티팩트와 이후 검토 영수증을 후속 GraphSnapshot에 프로젝션;
- `ObsidianVaultProjectionAdapter` 및 `NotionProjectionAdapter`;
- 양방향 동기화 또는 충돌 해결;
- 생성 페이지를 Context Compiler 입력으로 취급.

향후 어댑터는 이 렌더러의 의미적 ID를 보존하거나 별도로 버전이 지정된 형식/렌더러 계약을 선언해야 합니다. 공급자 페이지 ID, 보관소 루트, 타임스탬프 및 전송 진단은 코어 프로젝션 ID에 들어갈 수 없습니다.

## 경로 기준과 기존 Project

Project 내부 참조는 검증된 Project root를 기준으로 한 `/` 상대경로입니다. 생성
Markdown의 `relativePath`는 게시 root 기준이고, href는 해당 문서 위치 기준입니다.
문서의 `../` 링크가 원본 selector의 `..`를 허용하는 것은 아닙니다.

런타임 `project_root`, 저장된 `projectRoot`, 설치의 `pluginRoot`와 root 기반 식별자는
검증된 절대 root와 실제 Session 소유자에 계속 결합됩니다. 새 Project는 `.lode/`를
사용하고 기존 `.head/` 원문과 exact selector는 그대로 유지합니다. 이는 기존 경로
계약의 설명이며, workspace 이동 지원이나 자동 repair 기능이 아닙니다.


> 이 문서는 영어 원문 [`incremental-refresh.md`](../incremental-refresh.md)의 한국어 번역입니다.

# 관찰 상태의 증분 새로 고침

상태: 명시적 새로 고침, 디바운스된 파일시스템/CI 수집, 선택형 새로 고침 후 Markdown 프로젝션 활성화

프로토콜 버전: `0.2.0`; 다이제스트가 검증된 `0.1.0` 요청과 영수증도 계속 읽을 수 있음

## 목적

증분 새로 고침은 watcher, compute backend, graph 또는 document에 Product Canon에 대한 권한을 부여하지 않으면서 관찰된 프로젝트 상태를 재구성합니다. 이제 수동 트리거, 디바운스된 파일시스템 트리거, 구조화된 CI 트리거가 모두 동일한 검증된 새로 고침 파이프라인으로 들어갑니다.

현재 활성 파이프라인은 다음과 같습니다.

```text
manual request or verified RefreshTriggerBatch
  -> exclusive project World Model writer lease
  -> verified current World Model
  -> content-derived IncrementalRefreshRequest
  -> rediscover and byte-hash every eligible file
  -> reuse analysis only for digest-identical verified files
  -> validate one complete RepositoryScanResult
  -> preview a child SourceSnapshot and GraphSnapshot
  -> persist and verify graph materialization
  -> atomically advance the World Model pointer
  -> persist an immutable IncrementalRefreshReceipt
  -> advance the refresh receipt pointer
  -> evaluate a separate PostRefreshProjectionPolicy
  -> persist an immutable PostRefreshProjectionReceipt
```

파일시스템 및 CI adapter는 변경된 파일의 진실을 제공하지 않습니다. 이들은 전체 검색 및 hashing 파이프라인을 실행하게 하는 범위가 한정된 증거를 제공합니다. 새로 고침 core 자체는 문서를 게시하지 않습니다. 별도의 안전한 기본 수동 정책이 새로 고침 성공 후 결정론적 Markdown을 다시 생성할 수 있습니다. [`refresh-trigger.md`](refresh-trigger.md)와 [`post-refresh-projection.md`](post-refresh-projection.md)를 참조하세요.

## 권한 경계

새로 고침은 다음과 같은 관찰된 사실을 업데이트할 수 있습니다.

- 파일 콘텐츠 다이제스트 및 분류;
- 휴리스틱 symbol, import, dependency, binding, call;
- 불변 File, Symbol, Test revision;
- SourceSnapshot, GraphSnapshot, World Model materialization;
- 이미 검증된 adapter를 통해 제공된 읽기 전용 runtime observation.

새로 고침은 다음을 수행할 수 없습니다.

- Feature, Capability, Requirement, Constraint, Decision 또는 기타 Product Canon 변경;
- Feature mapping, Change impact, onboarding candidate 또는 document change 수락;
- instruction, promotion, canon-mutation 또는 control authority 부여;
- 기존 World Model, SourceSnapshot, revision, Capsule, contract, Run 또는 ResultPacket 재작성;
- 활성 Run에 고정된 ContextCapsule 교체;
- document publication을 Canon, promotion, instruction 또는 active-Run mutation authority로 사용.

명시적인 새로 고침 후 운영 정책은 World Model 전환 검증이 끝난 뒤에만 Markdown을 게시할 수 있습니다. 편집되었거나 관리되지 않는 view는 보존되고, 현재 편집 내용은 base graph에 대한 비권위적 candidate로 캡처되며, projection 실패는 검증된 World Model pointer를 롤백하지 않습니다. 자동 Obsidian 및 Notion publication은 계속 유예됩니다.

graph는 계속 재구축 가능한 projection입니다. Git과 GraphDB는 선택 사항이며 새로 고침 identity, ancestry 또는 recovery에 필요하지 않습니다.

## 변경 파일 재사용 경계

증분이라는 말은 timestamp나 watcher hint를 신뢰한다는 뜻이 아니라 semantic analysis를 재사용한다는 뜻입니다. 모든 대상 path를 다시 검색하고 모든 대상 파일을 읽으며, `repository.scan.v1`과 동일한 한도 아래 raw byte를 SHA-256으로 hashing합니다.

이전 analysis는 다이제스트가 검증된 이전 scan과 다음 항목이 모두 일치할 때만 재사용됩니다.

- 정규화된 상대 path;
- raw-byte digest;
- byte length;
- classification;
- language;
- repository-scan 및 source-analysis protocol version.

변경되거나 추가된 파일은 JavaScript reference semantics로 분석합니다. 제거된 path는 완전한 이전/이후 path set에서 탐지합니다. 최종 `RepositoryScanResult`는 기존 `repository.scan.v1` schema와 identity를 사용하므로, conforming full scan과 incremental scan은 동일한 result, result digest, semantic graph 및 World Model input을 생성합니다.

reuse count, analyzed path, backend name 및 execution mode는 운영 진단 정보입니다. 이들은 repository-scan, World Model, SourceSnapshot, GraphSnapshot, ContextCapsule, request 또는 receipt의 semantic identity에 참여하지 않습니다.

## 요청 계약

`IncrementalRefreshRequest`는 다음 항목을 결속합니다.

- project identity;
- 정확한 base World Model 및 SourceSnapshot identity;
- trigger kind 및 정렬된 evidence identity;
- 발견된 change 또는 정확히 정렬된 changed-path expectation 중 하나;
- 선택적인 명시적 추가 SourceSnapshot parent;
- 거짓으로 설정된 instruction, promotion 및 canon-mutation authority.

명시적 CLI는 `trigger.kind: manual`을 내보냅니다. 활성 filesystem watcher와 structured CI ingestion은 `filesystem` 및 `ci`를 내보내며, 각 요청은 정확히 하나의 불변 `RefreshTriggerBatch`를 evidence로 지정합니다. `change-set`과 `runtime-observation`은 이후의 검증된 adapter를 위해 계속 예약되어 있습니다. event path는 hint일 뿐이며 exact change expectation이 되지 않습니다.

exact changed-path expectation은 관찰된 added, changed, removed path의 합집합이 다를 경우 World Model pointer를 변경하기 전에 실패합니다.

## Snapshot 및 revision ancestry

관찰된 input이나 canonical input이 변경되지 않았고 새로운 명시적 parent도 제공되지 않았다면, 새로 고침은 `unchanged` receipt를 기록하고 현재 World Model 및 SourceSnapshot identity를 유지합니다.

새로 고침이 필요한 경우:

- 검증된 현재 SourceSnapshot이 자동으로 parent가 됩니다;
- 선택적인 명시적 추가 parent는 정렬되고 중복 제거됩니다;
- 변경되지 않은 logical entity는 기존 revision identity와 parent set을 유지합니다;
- 변경된 logical entity는 이전 current revision을 parent로 삼는 새 revision을 생성합니다;
- 새 entity는 revision parent 없이 시작합니다;
- 제거된 entity는 다음 current projection에는 없지만 이전 immutable snapshot에서는 계속 참조할 수 있습니다.

이는 자동 merge 또는 conflict resolution을 구현하지 않으면서 multiple-parent DAG 형태를 지원합니다.

## 활성 실행의 drift

활성 Run은 새로 고침으로 중지되거나 변경되지 않습니다. 해당 Run record, ExecutionContract, WholePlanSnapshot 및 ContextCapsule은 고정된 상태로 유지됩니다. receipt는 다음 항목을 기록합니다.

- Run, plan, contract 및 Capsule identity;
- 존재하는 경우 Capsule에 고정된 SourceSnapshot;
- 새로 고친 SourceSnapshot;
- drift 존재 여부;
- 필요한 Lode 선택: 고정된 input으로 계속 진행, 재컴파일, 수정 또는 취소.

pending ResultPacket도 마찬가지로 Fresh Lode review를 위해 동결된 상태로 유지됩니다. 새로 고침 evidence는 review에 정보를 제공할 수 있지만 result 또는 그 result가 수락한 execution input을 재작성할 수 없습니다.

## 불변 아티팩트

로컬 reference implementation은 다음 위치에 저장합니다.

```text
.lode/refresh/requests/incremental-refresh-request-*.json
.lode/refresh/receipts/incremental-refresh-receipt-*.json
.lode/refresh/current.json
.lode/refresh/triggers/batches/refresh-trigger-batch-*.json
.lode/refresh/triggers/deliveries/refresh-trigger-delivery-*.json
.lode/refresh/triggers/current.json
.lode/document-projection/post-refresh/policies/post-refresh-projection-policy-*.json
.lode/document-projection/post-refresh/receipts/post-refresh-projection-receipt-*.json
.lode/document-projection/post-refresh/current-policy.json
.lode/document-projection/post-refresh/current.json
```

request와 receipt는 콘텐츠에서 파생되는 불변 아티팩트입니다. current file은 다이제스트가 검증된 교체 가능 pointer입니다. 이후의 full index 또는 refresh로 최신 receipt가 stale 상태가 될 수 있지만 그 역사적 증거가 무효화되지는 않습니다.

## CLI 및 MCP

```powershell
node scripts/lode.mjs world-refresh <project>
node scripts/lode.mjs world-refresh <project> --expect-changed src/a.mjs,src/b.mjs
node scripts/lode.mjs world-refresh-status <project>
node scripts/lode.mjs world-refresh-read <project> --receipt incremental-refresh-receipt-<24-hex>
node scripts/lode.mjs world-refresh-events <project> --input refresh-events.json
node scripts/lode.mjs world-refresh-watch <project> --debounce-ms 350 --max-events 1024
node scripts/lode.mjs world-refresh-trigger-status <project>
node scripts/lode.mjs world-refresh-trigger-read <project> --delivery refresh-trigger-delivery-<24-hex>
node scripts/lode.mjs world-docs-policy-set <project> --input post-refresh-policy.json
node scripts/lode.mjs world-docs-policy-status <project>
node scripts/lode.mjs world-docs-refresh-status <project>
node scripts/lode.mjs world-docs-refresh-read <project> --receipt post-refresh-projection-receipt-<24-hex>
```

`--trigger-evidence`는 정렬된 evidence identity를 추가합니다. `--parent-snapshot`은 추가 SourceSnapshot parent를 선언하며, merge를 요청하거나 수행하지 않습니다.

읽기 전용 MCP는 다음을 노출합니다.

- `lode_incremental_refresh_status`;
- `lode_incremental_refresh_receipt`;
- `lode_refresh_trigger_status`;
- `lode_refresh_trigger_delivery`;
- `lode_post_refresh_projection_status`;
- `lode_post_refresh_projection_receipt`.

MCP는 새로 고침 mutation을 노출하지 않습니다.

## 실패 정책

새로 고침은 다음 경우 fail-closed 방식으로 실패합니다.

- base artifact 누락, stale 상태, 변조 또는 불일치;
- repository-scan request, response, result 또는 digest 불일치;
- exact changed-path expectation 불일치;
- 잘못된 path 또는 parent identity;
- World Model preview drift 또는 동시 pointer conflict;
- project World Model writer lease ownership이 active, unknown, unsafe 또는 mismatched 상태임;
- trigger batch, delivery, incremental-link 또는 trigger-pointer 불일치;
- graph projection failure 또는 semantic divergence;
- request, receipt 또는 pointer digest 불일치;
- active Run state가 해당 Run 또는 Capsule artifact와 일치하지 않음.

pointer가 전진하기 전에 검증이 실패하면, 기존의 검증된 World Model pointer가 현재 derived state에 대한 authority를 계속 보유합니다.

document policy, adapter, renderer 또는 publication 실패는 refresh-core 전환 후 격리됩니다. 이는 `failed` post-refresh receipt를 기록하고 검증된 World Model, Product Canon, active execution input 및 기존 published view를 보존합니다.

## 유예된 다음 단계

검증된 trigger queue와 선택형 post-refresh Markdown policy는 이제 문서에 authority를 부여하지 않으면서 로컬 자동 observed-state-to-human-view 경로를 완성합니다. 명시적 DocumentChangeCandidate review/application과 그 temporal audit projection은 활성화되어 있습니다. 자동 remote GraphDB refresh, background service installation, provider-specific CI webhook, Obsidian/Notion publication 및 bidirectional document synchronization은 이후 단계로 계속 유예됩니다.

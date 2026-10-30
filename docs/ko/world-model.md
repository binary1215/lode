# 저장소 World Model 시맨틱 알파

[영어 원문](../world-model.md)

이 플레인을 변경하기 전에 [`architecture.md`](architecture.md)와
[`authority-plane-contract.md`](authority-plane-contract.md)를 읽으세요.

## 권한 및 저장소 계약

Repository World Model은 재구축 가능한 구체화 뷰입니다. Context Compiler를 위한 증거일 뿐, 프로젝트 Canon도 지시 권한도 아닙니다.

버전 0.2는 `WorldModelStoreAdapter` 버전 `0.1.0`을 통해 콘텐츠 주소형 시맨틱 스냅샷을 물리 저장소와 분리합니다. 모든 어댑터는 다음을 선언해야 합니다.

- `authority: derived-evidence-only`;
- `rebuildable: true`;
- `uniqueAuthority: false`;
- 버전 호환 포인터, 불변 스냅샷 및 목록 조회 작업.

인터페이스 메서드는 `describe`, `readPointer`, `readSnapshot`, `writePointer`, `writeSnapshot`, `listSnapshotIds`입니다. Core 코드는 시맨틱 다이제스트 검증을 수행하고, 어댑터는 문서를 저장하고 가져오기만 합니다. 이를 통해 백엔드가 식별자 검사를 약화하지 못하게 합니다.

현재 활성화된 종속성 없는 로컬 JSON 어댑터의 저장 위치는 다음과 같습니다.

```text
.lode/world-model/current.json                    Warm pointer and change summary
.lode/world-model/snapshots/world-model-*.json.gz  New compact + gzip snapshots
.lode/world-model/snapshots/world-model-*.json     Retained legacy snapshots
```

새 로컬 스냅샷은 `.json.gz`를 사용하며 기존 `.json`은 원본을 유지하고 계속 읽을 수 있습니다. 물리 한도·ignore 규칙·읽기 전용 GC 진단은 [스냅샷 저장과 보존](snapshot-storage.md)을 참고하세요.

`current.json`은 Hot 스냅샷을 가리키고 물리 어댑터 설명자를 기록하며 추가·변경·삭제된 경로를 Warm 티어로 기록합니다. 이전 콘텐츠 주소형 스냅샷이 Cold 티어를 이룹니다. 물리 어댑터 설명자는 시맨틱 스냅샷 해시에 포함되지 않으므로, 동일한 정규 입력은 규격을 준수하는 로컬, 메모리 또는 향후 GraphDB 어댑터에서 동일한 World Model ID를 생성합니다.

GraphDB는 필수가 아니며 원격 데이터베이스를 조회하거나 변경하지 않습니다. 이제 그래프 순회는 별도의 `GraphProjectionAdapter`를 사용하며, World Model 저장소는 그래프 백엔드와 독립적으로 완전하고 복구 가능한 스냅샷을 계속 보존합니다. 별도의 `DocumentProjectionAdapter`는 문서 어댑터나 파일시스템 식별자를 World Model에 넣지 않고 현재 검증된 GraphSnapshot을 결정론적 Markdown으로 명시적으로 렌더링합니다. [`graph-projection-adapter.md`](graph-projection-adapter.md)와 [`document-projection-adapter.md`](document-projection-adapter.md)를 참고하세요.

## 명령

일반 인덱싱과 도메인 투영 재구축도 스캔 설정과 producer가 같으면 기존의 검증된
증분 소스 스캔을 재사용합니다. 현재 대상 파일은 여전히 모두 읽고 해시합니다.
모든 소스 사실·범위·규칙·검증된 source-relation 입력이 같을 때만 전체 의미 그래프를
재사용합니다. 파일 추가·삭제·이름 변경·내용 변경이 있으면 파일 간 import 해석을 포함해
그래프를 다시 계산합니다. 명시한 compute adapter의 실행 선택은 유지합니다.
기본 whole 스냅샷과 domain bundle 모두에 적용되는 최적화입니다.

`world-index`에서 부모 입력을 생략하면 검증된 현재 부모 집합을 유지합니다.
빈 배열이나 병합 부모를 명시한 경우는 생략과 구분합니다. 따라서 전체 근거가 같으면
index와 refresh를 오가도 World·Graph 식별자를 유지합니다. 필요한 포인터·투영 복구와
변경 없는 refresh 영수증은 계속 처리합니다. 새 불변 스냅샷이 없다는 사실을 파일 쓰기
전체가 없다는 뜻으로 확대하지 않습니다. Canon·포인터·digest·권한 오류도 그대로 유지합니다.

```text
node scripts/lode.mjs world-index <project>
node scripts/lode.mjs source-scope-set <project> --input <source-scope.json>
node scripts/lode.mjs source-scope-status <project>
node scripts/lode.mjs world-index <project> --git-log <host-exported-log-file>
node scripts/lode.mjs world-index <project> --runtime-state <host-exported-json-file>
node scripts/lode.mjs world-index <project> --parent-snapshot <source-snapshot-id,source-snapshot-id>
node scripts/lode.mjs world-index <project> --revision-parents <logical-entity-to-parent-revisions.json>
node scripts/lode.mjs world-refresh <project>
node scripts/lode.mjs world-refresh <project> --expect-changed <path,path>
node scripts/lode.mjs world-refresh-status <project>
node scripts/lode.mjs world-refresh-read <project> --receipt <incremental-refresh-receipt-id>
node scripts/lode.mjs world-refresh-events <project> --input <refresh-events.json>
node scripts/lode.mjs world-refresh-watch <project> --debounce-ms 350 --max-events 1024
node scripts/lode.mjs world-refresh-trigger-status <project>
node scripts/lode.mjs world-refresh-trigger-read <project> --delivery <refresh-trigger-delivery-id>
node scripts/lode.mjs world-status <project>
node scripts/lode.mjs world-graph-status <project>
node scripts/lode.mjs world-docs-build <project>
node scripts/lode.mjs world-docs-status <project>
node scripts/lode.mjs world-docs-capture <project>
node scripts/lode.mjs world-docs-candidates <project> --candidate-set <document-change-candidate-set-id>
node scripts/lode.mjs world-docs-policy-set <project> --input <policy.json>
node scripts/lode.mjs world-docs-policy-status <project>
node scripts/lode.mjs world-docs-refresh-status <project>
node scripts/lode.mjs world-docs-refresh-read <project> --receipt <post-refresh-projection-receipt-id>
node scripts/lode.mjs world-query <project> --query <symbol-or-path> --depth 1 --limit 100
node scripts/lode.mjs world-temporal <project> --query <path-or-symbol> --relations HAS_REVISION,CURRENT_REVISION,DECLARES --depth 2 --limit 100 --edge-limit 200
node scripts/lode.mjs world-temporal <project> --query <candidate-id> --include-candidates true --depth 1 --limit 100 --edge-limit 200
node scripts/lode.mjs world-history <project> --query <decision-terms> --limit 20
node scripts/lode.mjs world-runtime <project> --runtime codex --state active --kind session --limit 20
node scripts/lode.mjs change-set-status <project>
```

`world-index`는 검증된 `repository.scan.v1` 작업을 호출하고 결정론적 스냅샷을 구체화합니다. 저장소 변경 없이 반복 실행하면 동일한 World Model ID를 반환합니다. 선택적 `.lode/context/repository-source-scope.json` 선택 항목은 정규화된 포함/제외 루트를 제공하고, 증거 전용으로 유지되며, 스캔과 World Model 식별자에 참여합니다. `world-status`는 먼저 적격 파일 전체를 탐색하고 바이트 해싱을 수행합니다. 경로, 다이제스트, 바이트 길이, 분류, 언어 및 범위가 검증된 스냅샷과 일치하면 저장된 시맨틱 분석을 재사용하며, 단지 최신 상태임을 증명하기 위해 시간 그래프를 재구축하지 않습니다. 인벤토리가 변경되면 정확한 오래됨 상세 정보를 보고하기 전에 완전한 참조 스캔으로 폴백합니다.

`world-refresh`는 검증된 기본 인덱스 이후의 명시적 증분 경로입니다. 여전히 모든 적격 파일을 다시 탐색하고 원시 바이트 해싱하지만, 경로, 다이제스트, 바이트 길이, 분류, 언어 및 분석 프로토콜이 검증된 이전 스냅샷과 일치하는 파일에만 심볼·종속성·시맨틱 분석을 재사용합니다. 결과 `RepositoryScanResult`는 완전한 참조 스캔과 동일하게 유지됩니다. 변경 없는 새로 고침은 현재 스냅샷 식별자를 유지합니다. 변경된 새로 고침은 이전 SourceSnapshot을 자동으로 연결하고, 변경되지 않은 리비전 식별자를 재사용하고, 변경된 리비전의 부모를 이전 리비전으로 지정하고, 그래프 구체화를 검증하며, 불변 요청/영수증 증거를 기록합니다. 관찰된 경로가 정확한 `--expect-changed` 집합과 다르면 포인터를 전진시키기 전에 실패합니다. [`incremental-refresh.md`](incremental-refresh.md)를 참고하세요.

`world-refresh-events`는 엄격한 CI 배치 하나를 수집합니다. `world-refresh-watch`는 유일한 파일시스템 CLI 어댑터이며 `SIGINT` 또는 `SIGTERM`까지 포그라운드에서 재귀적으로 실행됩니다. 둘 다 제한된 결정론적 디바운스/병합 계약과 프로젝트 범위의 배타적 작성자 리스를 사용합니다. 이벤트 경로는 스캔 범위를 제한하지 않으며 실제 변경 파일과 다를 수 있습니다. 완전한 탐색과 해싱이 관찰된 구현에 대한 권위 있는 근거로 유지됩니다. 읽기 전용 트리거 상태 및 전달 검사는 감시자를 시작하지 않고 연결된 증분 요청/영수증을 검증합니다. [`refresh-trigger.md`](refresh-trigger.md)를 참고하세요.

저장소 파일 변경, 제품 Git ref, 시맨틱 Lode 수명주기 상태 및 인덱서 프로토콜 버전은 모두 소스 다이제스트에 참여합니다. 제품 Git ref는 정확히 로컬 브랜치, 원격 추적 ref 및 태그입니다. `refs/codex/turn-diffs/**` 같은 호스트 운영 ref는 loose 또는 packed 여부와 관계없이 제외됩니다. 이는 제품 증거가 아니라 P5 대화 장부이기 때문입니다. 현재 체크아웃된 Lode는 제외된 네임스페이스를 가리키더라도 계속 관찰됩니다. 체크아웃 상태가 작업 트리 의미를 바꾸기 때문입니다. 변동 타임스탬프, ref 저장 레이아웃 및 물리 저장소 식별자는 제외됩니다.

읽기 전용 MCP 도구 `lode_world_model`은 `world-status`와 동일하게 완전한 스냅샷 다이제스트, 구조 및 저장소 최신 상태를 검증하지만, 제한된 `WorldModelStatusProjection`만 반환합니다. 이 프로젝션에는 식별자, 다이제스트, 수치형 개수, 변경 분류별 최대 20개 경로, 비활성 파일 샘플, 명시적인 생략 개수 및 생략된 전체 스냅샷의 간결한 직렬화 바이트 길이가 포함됩니다. 완전한 `snapshot`, 물리 스냅샷 경로 또는 제한 없는 최신 상태 배열은 절대 반환하지 않습니다. 프로젝션은 512 KiB로 제한되고 중복된 JSON-RPC 텍스트/구조화 MCP 봉투는 4 MiB로 제한됩니다. 이는 전송 한계이지, 검증이나 인덱싱 한계를 줄인 것이 아닙니다. 제한된 상세 정보에는 `lode_world_query`, `lode_temporal_graph`, `lode_git_history` 또는 `lode_runtime_state`를 사용하고, 완전한 스냅샷이 운영상 필요한 경우에만 로컬 `world-status` CLI를 사용하세요.

`lode_context_preview`는 비영속 `ContextWorkflowProjection`에서 World의 현재·부재·stale 제외를 공개합니다.
출처 연결 selection, 누락과 불확실성을 제공하며 고정 tier나 포함 증명 gate는 없습니다.
World가 없어도 현재 source를 직접 맥락으로 사용할 수 있습니다.
확대나 refresh가 유용한지는 Lode가 판단합니다. preview는 World 변경, 승인,
의미 선택이나 복구 방향 쓰기를 수행하지 않습니다.

`lode_graph_projection_status`는 그래프 프로젝션 검증을 노출합니다. `lode_incremental_refresh_status`와 `lode_incremental_refresh_receipt`는 변경 권한 없이 새로 고침 최신 상태, 계보, 변경 및 활성 실행 드리프트를 노출합니다. `lode_refresh_trigger_status`와 `lode_refresh_trigger_delivery`는 이벤트를 수집하거나 감시자를 시작할 수 없지만 이벤트 배치, 직렬화된 전달 및 연결된 새로 고침 증거를 검증합니다. `lode_post_refresh_projection_status`와 `lode_post_refresh_projection_receipt`는 어느 쪽도 변경하지 않으면서 유효 정책과 정확한 문서 결과를 검증합니다. `lode_world_query`는 제한된 0~3홉 휴리스틱 시맨틱 이웃을 반환합니다. `lode_temporal_graph`는 현재 프로젝션 어댑터를 통해 그래프/쿼리/결과 다이제스트를 포함한 결정론적 허용 목록 기반 시간 순회를 반환하며, 프로젝션이 없으면 공개된 임베디드 그래프 폴백을 반환합니다. `lode_git_history`는 검증된 현재 Git 증거에 대해 제한된 쿼리를 수행합니다. `lode_runtime_state`는 검증된 특정 시점 런타임 관찰에 대해 제한된 쿼리를 수행합니다. 모든 시맨틱 쿼리는 오래된 인덱스를 거부합니다.

## 시간적 출처 그래프

World Model 버전 `0.14.0`에는 저장소 스캔 프로토콜 `0.4.0`, 저장소 소스 범위 프로토콜 `0.1.0`, 소스 분석 프로토콜 `0.2.0`, 시맨틱 그래프 프로토콜 `0.2.0`, 온보딩 프로젝션 프로토콜 `0.1.0`, Feature 매핑 프로토콜 `0.2.0`, ChangeSet 프로토콜 `0.1.0`, ChangeSet 프로젝션 프로토콜 `0.2.0`, 문서 변경 그래프 프로젝션 프로토콜 `0.1.0`, `0.1.0` 아티팩트 읽기 호환성을 갖는 Product Operating Loop 프로토콜 `0.2.0`, release observation 프로토콜 `0.1.0`, VCS 증거 프로토콜 `0.1.0`, GraphProjectionAdapter `0.1.0`, 증분 새로 고침 프로토콜 `0.2.0`, 새로 고침 트리거 프로토콜 `0.2.0` 및 시간적 출처 프로토콜 `0.11.0`으로 구축된 별도의 P4 `GraphSnapshot`이 포함됩니다. 버전 `0.14.0`은 digest-verified release-observation projection manifest를 추가하고 정규 product ref 상태를 Host-operational ref와 분리해 유지합니다. P4 경계는 콘텐츠에서 파생된 AuthorityPlaneContract를 통해 검증되고, 그래프 구체화는 Product Canon 바이트와 차단됩니다. World Model `0.11.0`, `0.12.0`, `0.13.0`은 다이제스트 및 교차 프로젝션 검증이 가능하지만 현재 인덱서 계약으로 재구축될 때까지 오래된 상태가 됩니다. 레거시 저장소 스캔 `0.2.0` 및 `0.3.0` 스냅샷은 다이제스트 검증이 가능하지만 새 인덱서 계약으로 재구축될 때까지 오래된 상태가 됩니다. 저장소 스캔 `0.4.0`은 사용자가 선택한 소스 범위를 보존하면서 일반적인 Python 런타임 및 캐시 디렉터리를 적격 제품 증거에서 제외합니다. 시간 그래프는 불변 온보딩 이력, Feature/코드/테스트 매핑 후보, 검토된 공급자 중립 ChangeSet, 정확한 리비전 델타, 검토 게이트를 거친 Feature/Capability 영향, 선택적 ChangeSet-Git 증거, 문서 검토/적용 감사 계보, 인식론적으로 유형화된 제품 운영 증거 및 provider-neutral branch/deployment/release observation을 추가합니다. 비영속 제품 메모는 World Model에 절대 들어가지 않습니다. v0.2 Initiative 후보는 인라인 추론을 사용할 수 있고 명시적 검토까지 Feature 해소를 미룰 수 있습니다. 별도의 검토된 Initiative는 정확한 해소를 담습니다. 후보 표면은 기본적으로 숨겨진 상태로 유지됩니다. 범위가 지정된 명시적 ReviewDecision만 검토 영수증 또는 정규 관계를 생성합니다. 문서 ReviewDecision은 P1 규범 기록으로, 적용 영수증은 불변 P3 증거로 유지되며, 그 그래프 노드는 P4 파생 증거로 유지됩니다. 증분 새로 고침과 트리거 수집은 스냅샷 스키마를 변경하지 않습니다. 배칭, 타이밍, 작성자 소유권, 재사용 및 어댑터 진단은 World Model 및 GraphSnapshot 시맨틱 식별자 외부에 유지됩니다. 레거시 새로 고침 `0.1.0` 아티팩트는 계속 읽을 수 있습니다.

저장소 스캔은 최초의 내장 `ComputeAdapter` 작업입니다. 시맨틱 출력에는 정규화된 상대 경로와 결정론적 소스 사실만 포함됩니다. 스캔 루트는 운영 입력이며 저장소 스캔 결과에서 제외됩니다. 백엔드 식별자, 실행 모드, 타이밍 및 프로세스 상세 정보는 World Model 식별자 외부의 포인터 진단으로 유지됩니다. 이제 Go 구현은 추적 코퍼스와 한계/오류 픽스처에서 바이트 단위로 동일한 완전한 응답을 생성하지만, 측정 결과 소규모 및 중간 규모 스캔 성능이 저하되고 대규모 입력의 이득이 미미하므로 릴리스 매니페스트는 이를 의도적으로 광고하지 않습니다. 따라서 기본 어댑터는 검증된 배포판을 프로브하고 `GO_WORKER_OPERATION_NOT_INSTALLED`를 공개한 뒤 JavaScript 참조 구현을 실행합니다. World Model은 별도로 검증된 정규 프로젝트 루트를 계속 기록합니다.

시간 그래프는 라이브 Git 상태를 절대 읽지 않습니다. `.git`이 없는 프로젝트도 동일한 프로젝트 ID, 소스 스캔, 명시적 부모 집합 및 생산자 버전으로 동일한 필수 시간 식별자를 구성하고 쿼리합니다. 운영자가 검증된 Git 이력에 이미 존재하는 커밋을 명시적으로 첨부하면, 그래프는 그 결과인 불변 `VcsEvidence` 아티팩트와 내장 커밋 관찰만 사용합니다. 따라서 동일한 선택적 증거 플레인은 Git이 사라진 뒤에도 재구축됩니다. 식별자, 계보, 검증 및 제한된 순회 계약은 [`temporal-provenance.md`](temporal-provenance.md)를 참고하세요.

## Git 결정 증거

`GitHistoryAdapter` 버전 `0.2.0`은 공급자 중립의 파생 증거 전용 경계입니다. 규격을 준수하는 어댑터는 `rebuildable: true`와 `uniqueAuthority: false`를 선언해야 합니다. 물리 식별자는 콘텐츠에서 파생된 Git 이력 ID와 World Model ID에서 제외됩니다. 버전 `0.1.0` 어댑터는 업그레이드 연속성을 위해 계속 읽을 수 있지만, 정규화, 호스트 ref 필터링 및 새로 생성되는 모든 GitDecisionHistory는 현재 `0.2.0` 계약을 사용합니다.

기본 `git-cli` 어댑터는 World Model이 제공한 정확한 현재 브랜치, 원격 추적, 태그 및 Lode 루트에서 도달 가능한 커밋을 비동기적으로 읽습니다. 커밋 및 부모 식별자, 작성/커밋 타임스탬프, 작성자 이메일의 다이제스트, 제품 ref, 제목, 본문 및 `git:<sha>` 증거 출처를 기록합니다. CLI와 바이트 보존 파서는 그 밖에는 제품에서 도달 가능한 커밋의 decoration을 포함하여 모두 `refs/codex/turn-diffs/**`를 제외합니다. 현재 로컬 브랜치, 원격 ref 및 태그는 `.git`에서 각각 독립적으로 읽히며, 어댑터 결과를 정확히 부모로 도달 가능한 집합에 맞춰 검증하고 가지치기하는 데 사용됩니다. 따라서 파일이 변경되지 않아도 시맨틱 대상이 변경되면 World Model이 오래된 상태가 됩니다. packing, 주석, 순서 또는 호스트 전용 ref는 오래된 상태로 만들지 않습니다.

일부 제한된 호스트는 Node 프로세스가 Git을 실행하지 못하게 합니다. 이는 어댑터 수준의 fail-open 조건입니다. 인덱싱은 `gitHistory: none`과 안정적인 이유 코드를 사용하여 계속됩니다. 대신 호스트가 아래의 정확한 명령으로 바이트 보존 로그 파일을 생성하고 명시적으로 제공할 수 있습니다.

```text
git -C <project> --no-pager log HEAD --branches --remotes --tags --topo-order --date-order --no-show-signature --decorate=full --decorate-refs-exclude=refs/codex/turn-diffs/** --format=%H%x00%P%x00%aI%x00%cI%x00%an%x00%ae%x00%D%x00%B%x00
node scripts/lode.mjs world-index <project> --git-log <host-exported-log-file>
```

로그 파일 어댑터는 누락 파일, 심볼릭 링크, 일반 파일이 아닌 항목 및 크기 초과 입력을 거부합니다. Core는 여전히 내보낸 커밋을 현재 ref와 대조하여 검증합니다. 커밋 메시지는 과거 결정 증거일 뿐입니다. 모든 레코드는 `instructionAuthority: false`와 `evidence-not-instruction`을 가지며, 인덱스는 메시지를 승인된 프로젝트 `Decision`으로 절대 바꾸지 않습니다.

## 외부 런타임 상태

`RuntimeStateAdapter` 버전 `0.1.0`은 엄격한 특정 시점 호스트 내보내기를 재구축 가능한 증거로 가져옵니다. 읽기 전용이며 향후 `AgentRuntimeAdapter` 제어 경계와 분리됩니다. 원시 공급자 ID는 해싱되고, 프로젝트 외부 워크스페이스 경로도 해싱됩니다. 원시 명령, 엔드포인트, 환경, 프롬프트, 트랜스크립트, 자격 증명 및 임의 메타데이터는 거부됩니다. 광고된 기능은 제어 권한을 절대 부여하지 않습니다.

어댑터 설명자와 물리 소스 경로는 World Model 포인터에만 존재하므로 최신 상태 검사에서 시맨틱 식별자를 변경하지 않고 내보내기를 다시 읽을 수 있습니다. 정규화된 관찰 콘텐츠가 `runtimeStateId`를 결정합니다. 변경된 내보내기는 World Model을 오래된 상태로 만들며 재구축 전까지 런타임 후보를 제외합니다. 스키마와 정확한 경계는 [`runtime-state.md`](runtime-state.md)를 참고하세요.

## 활성 범위

- 최대 512 KiB의 지원되는 텍스트 파일;
- 결정론적 경로 및 콘텐츠 다이제스트;
- 최대 파일 수, 파일별 바이트, 총 바이트, 입력, 출력 및 시간 제한 경계를 적용하여 검증된 `repository.scan.v1` 출력;
- 소스, 테스트, 문서 및 구성 분류;
- 휴리스틱 JavaScript/TypeScript, Python 및 Markdown 심볼;
- JavaScript/TypeScript/Python 모듈 참조, 로컬 모듈 해소 및 패키지 매니페스트 종속성;
- 콘텐츠에서 파생된 File, Symbol 및 ExternalDependency 노드;
- 증거가 연결된 `DECLARES`, `IMPORTS` 및 해소 가능한 `CALLS` 엣지;
- 안정적인 시간적 Repository/File/Symbol/Test 논리 엔티티와 불변 File/Symbol/Test 리비전;
- 불변 Canon 프로젝션 리비전을 갖는 안정적인 FeatureGroup, Capability, Feature, Requirement, Constraint 및 Decision 논리 엔티티;
- 의미 candidate proposal 전 온보딩에 의해 트리거되는 명시적 인덱싱과 ReviewDecision 게이트를 거친 Product Canon 승격 후 검증된 하위 SourceSnapshot/GraphSnapshot 재구축;
- 다이제스트 검증을 거친 온보딩 CandidateSet, Evidence, Unknown, ReviewDecision 및 ProductModelRevision 영수증 프로젝션과 후보-증거, 검토, 처분 및 승격 계보;
- 제한된 Feature/Capability-File/Symbol/Test 매핑 후보, 명시적 수락/거부 ReviewDecision, 별도의 검토 관계 영수증 및 정규 방향 `IMPLEMENTS`/`VERIFIED_BY` 엣지;
- 정확한 이전/이후 SourceSnapshot 및 File/Symbol/Test 리비전 차이, 정렬된 0개 이상의 ChangeSet 부모, Git 독립적 식별자를 갖는 수락된 실행 ChangeSet;
- 검토된 매핑을 통해서만 파생된 불변 변경 영향 후보, 명시적 수락/거부 ReviewDecision, 별도의 ReviewedImpact 영수증 및 정규 `IMPACTS` 엣지;
- 명시적 커밋 선택, 내장 Git 커밋 관찰, 변경되지 않는 ChangeSet 식별자 및 `MATERIALIZED_AS` / `REFERENCES` 그래프 관계를 갖는 선택적 불변 VCS 증거 첨부;
- 저장소 디렉터리 구조와 독립적으로 검증된 `CONTAINS`, `REALIZES` 및 `GOVERNED_BY` 제품 관계;
- 자동 병합 주장 없이 0개 이상의 SourceSnapshot 및 Revision 부모;
- 출처가 완전한 제품/저장소 엣지와 `PROPOSES_FROM`, `PROPOSES_TO`, `SUPPORTED_BY`, `REVIEWED_BY`, `ACCEPTED_BY`, `REJECTED_BY`, `PRODUCES` 및 `PROMOTED_FROM` 온보딩 엣지;
- 종류/관계/권한/최신 상태 허용 목록, 신뢰도 정책, 포함/제외 이유 및 그래프/쿼리/결과 다이제스트를 갖는 결정론적이고 제한된 시간 순회;
- 동일한 GraphSnapshot 및 순회 식별자, 검증된 포인터/스냅샷 구체화, 임베디드 그래프 폴백 공개 및 오래됨/변조/권한 거부를 갖는 로컬 JSON 및 인메모리 그래프 프로젝션 어댑터;
- 스냅샷 범위의 시맨틱 버텍스와 엣지, 콘텐츠에서 파생된 노드/엣지 집합 영수증, 정확한 부분 쓰기 재개, 상태 확인 시 완전한 원격 재검증 및 전체 원격 스냅샷/토폴로지를 다시 로드하지 않고 정확한 쿼리 반경을 검증하는 준비된 제한형 서버 확장을 갖는 활성화된 ArcadeDB 프로젝션;
- 파일 다이제스트 및 줄 출처, 휴리스틱 신뢰도, 미해소 개수 및 제한된 순회;
- gitfile·관리 디렉터리·commondir의 양방향 연결이 확인된 정상 linked worktree를 포함한 로컬 HEAD·제품 ref 해소. 임의의 외부 gitdir 포인터는 계속 미지원;
- 교체 가능한 CLI 및 호스트 내보내기 어댑터를 통한 콘텐츠 주소형 전체 도달 가능 Git 커밋 메시지 증거;
- create-only `BranchStateObservation`, `DeploymentResultObservation`, `ReleaseObservation` P3 evidence와 `AT_REVISION`, `OBSERVED_ON`, `EVIDENCED_BY`, 선택적 `DEPLOYS` P4 relation;
- 교체 가능한 읽기 전용 호스트 내보내기 어댑터를 통한 콘텐츠 주소형 특정 시점 외부 런타임 관찰;
- 현재 계획, 활성 Run/contract, 대기 중 검토 및 필수 계획 작업을 포함하는 시맨틱 Lode 수명주기 상태;
- 추가·변경·삭제된 경로 계산;
- 파일 수준 최신 상태;
- 경로, 다이제스트, 분류, 언어, 심볼, 종속성, 사전 인덱싱된 구조 인접 관계, 제한된 ProductContext와 현재 Project/World/Graph identity에 결속된 별도 Lode-exact `GraphTraversalEvidence`를 포함하는 Context Compiler 후보. Compiler는 lexical task overlap으로 temporal anchor를 고르지 않습니다.

관리되는 루트 프로젝션과 다음 디렉터리는 제외됩니다. `.lode`, `.git`, VCS 메타데이터, 종속성/벤더 디렉터리, 생성된 빌드 출력, 캐시(uv 및 pytest 캐시 포함), 가상 환경, 커버리지 출력입니다. 다른 도구가 생성한 증거는 기존 소스 범위(예: `excludeRoots: [".generated-evidence"]`)로 제외하며, 목록에 없는 `.github` 같은 숨김 디렉터리는 계속 수집 대상입니다. 심볼릭 링크와 지원되지 않는 파일, 바이너리 파일 또는 크기 초과 파일은 건너뛰고 개수에 포함합니다. 사용자가 선택한 소스 범위는 Product Canon을 변경하지 않고도 정규화된 프로젝트 상대 루트를 추가로 포함하거나 제외할 수 있습니다.

## Context Compiler 동작

- World Model 없음: Capsule 범위는 `curated-head-canon-only`로 유지됩니다;
- 현재 World Model: 작업 관련 저장소 파일, 제한된 시맨틱 및 시간 관계, 이력 클래스에 적격인 Git 증거 및 런타임 관찰이 일반 컨텍스트 예산 안에서 경쟁합니다;
- 일치하는 Product Canon 개념은 같은 예산 아래 하나의 제한된 `ProductContext` 파생 프로젝션으로 경쟁합니다;
- 오래된 World Model: 저장소 후보는 제외되고 Capsule 범위에 오래됨에 따른 제외가 명시적으로 기록됩니다;
- 모든 저장소 후보, 시맨틱 노드 및 엣지는 `evidence-not-instruction`으로 유지됩니다.
- 검토되지 않은 온보딩, Feature 매핑 및 변경 영향 후보 공간 노드는 기본적으로 제외되고 명시적인 CLI/MCP 옵트인이 필요합니다. Context Capsule은 절대 옵트인하지 않고 검토된 매핑과 영향만 사용합니다.

이로써 일반적인 선별 Canon 컴파일은 계속 허용하면서, 오래된 인덱스가 암묵적으로 실행을 지시하지 못하게 합니다.

## 명시적으로 연기된 항목

디바운스된 파일시스템 및 CI 트리거 수집과 단일 작성자 이벤트 병합은 활성화되어 있으며, 둘 다 동일한 증분 새로 고침 변경 경로에서 종료됩니다. 명시적으로 활성화된 자동 Markdown 재생성은 별도의 안전한 새로 고침 후 정책을 통해 활성화됩니다. 명시적 DocumentChangeCandidate 검토/적용과 그 시간 감사 프로젝션도 활성화됩니다. 백그라운드 서비스 설치, 공급자별 CI 웹훅 어댑터, 자동 GraphDB 새로 고침 및 자동 Obsidian/Notion 게시는 계속 연기됩니다.

- AST 정확도의 시맨틱 심볼, 동적 디스패치 및 완전한 호출 해소;
- 구조화된 결정 추론, 대체 모델링 및 Git 증거로부터의 승인된 승격;
- 특정 시점 호스트 내보내기를 넘어선 라이브 공급자/런타임 프로빙 및 스트리밍;
- 현재 제외 규칙을 넘어선 생성/벤더 소스 분류;
- 저장소 간 관계;
- 승인된 후보 지식 승격;
- 추론된 커밋-ChangeSet 일치, 적합성, 완전한 실행 계보 및 문서 아티팩트/검토 영수증을 이후 그래프 스냅샷에 다시 투영하는 기능;
- Obsidian 및 Notion 프로젝션 어댑터;
- 활성 구조화 브리프 입력을 넘어선 전용 가져온 백로그 어댑터;
- 자동 부모 추론, 병합 및 충돌 해소;
- 실행된 라이브 prepared-query 평가, compare-and-swap 게시 및 비 ArcadeDB 전송;
- 규격을 준수하는 Go `repository.scan.v1` 후보의 프로덕션 선택 또는 전송 상각, 그리고 벤치마크를 게이트로 한 그래프/순회/Context 작업 마이그레이션;
- 워커 매니페스트가 강제하는 자손 없음 계약을 넘어선 자손 프로세스 트리 감독.

향후 저장소는 버전이 지정된 어댑터 계약을 구현하고 동일한 콘텐츠 주소형 스냅샷, 다이제스트 검증, 최신 상태, 범위 및 재구축 가능성 의미를 보존해야 합니다. 원격 그래프 저장소가 순회를 가속할 수는 있지만 유일한 권한이 되거나 시맨틱 식별자를 변경할 수는 없습니다.

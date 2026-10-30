> 이 문서는 [graph-projection-adapter.md](../graph-projection-adapter.md)의 한국어판입니다. 코드, 명령, 프로토콜 식별자와 필드 이름은 원문 표기를 유지합니다.

# GraphProjectionAdapter 계약

이 경계를 변경하기 전에 [`architecture.md`](architecture.md)와
[`authority-plane-contract.md`](authority-plane-contract.md)를 읽으세요.

## 목적

`GraphProjectionAdapter` 버전 `0.1.0`은 semantic temporal `GraphSnapshot`을 이를 구체화하고 순회하는 데 사용되는 backend로부터 분리합니다. temporal provenance 프로토콜 `0.12.0`은 [`AuthorityPlaneContract`](authority-plane-contract.md)의 P4 경계를 내장합니다. World Model 안에 내장되어 digest로 검증된 GraphSnapshot은 프로젝션 재구축을 위한 복구 가능한 원본으로 유지됩니다. snapshot, local adapter, ArcadeDB adapter 중 어느 것도 Product semantic Canon, 지시 권위, 승격 권위 또는 유일한 권위가 아닙니다.

Product semantic Canon은 P1에 그대로 유지되며, Core GraphSnapshot은 그에 대한 P4 관계 및 검색 index입니다. graph의 ProductModel identity는 규범적 권위를 이전하지 않은 채 프로젝션된 정확한 원본에 결속됩니다. Distribution과 Host는 아키텍처 평면이지 추가적인 의미 평면이 아닙니다. graph adapter는 정확한 Product Canon byte fence 뒤에서 실행됩니다. 변경 또는 삭제가 발생하면 World Model pointer가 전진하기 전에 복원되고 거부됩니다.

이 계약은 `WorldModelStoreAdapter`를 대체하지 않고 그와 함께 존재합니다.

```text
canon + executable state + verified lineage
  -> RepositoryWorldModel containing recoverable GraphSnapshot
       -> GraphProjectionAdapter
            -> local JSON projection
            -> in-memory conformance projection
            -> activated ArcadeDB HTTP projection + local mirror
```

Backend identity, filesystem location, remote record ID, operational timing은 `GraphSnapshot`, `TraversalQuery`, `TemporalTraversalResult`, Context Capsule, World Model의 semantic identity에서 제외됩니다.

## 필수 인터페이스와 권위

모든 adapter는 host-facing 동기식 method를 구현합니다.

```text
describe
readPointer
readSnapshot
writePointer
writeSnapshot
listSnapshotIds
query
```

host-facing 계약은 동기식으로 유지됩니다. `ArcadeDbHttpTransport`는 비동기 HTTP 요청을 위해 exact-child Node bridge를 사용하고 표준 입력/출력을 통해 크기가 제한된 JSON을 교환합니다. credential value는 해당 child 내부에서만 이름이 지정된 environment variable로부터 해석되며, command argument, request artifact, activation receipt, descriptor 또는 semantic identity에 절대 포함되지 않습니다.

모든 descriptor는 다음을 선언해야 합니다.

```text
contract: replaceable-rebuildable-derived-graph-projection
authority: derived-evidence-only
rebuildable: true
uniqueAuthority: false
instructionAuthority: false
promotionAuthority: false
remote: boolean
durable: boolean
```

project canon, 지시, 승격 또는 유일한 권위를 주장하는 adapter는 구체화 전에 거부됩니다.

## 로컬 구체화

기본 local adapter는 다음을 저장합니다.

```text
.lode/graph-projection/current.json
.lode/graph-projection/snapshots/graph-snapshot-*.json.gz
.lode/graph-projection/snapshots/graph-snapshot-*.json
```

새 로컬 스냅샷은 공백을 줄인 `.json.gz`를 사용하며 기존 `.json`은 원본 바이트를 유지합니다. 물리 인코딩과 현재 조회 전용 GC 표면은 [스냅샷 저장과 보존](snapshot-storage.md)을 참고하세요.

snapshot은 불변이며 canonical JSON 기준으로 현재 World Model에 내장된 검증된 graph와 byte-semantic하게 동등합니다. pointer는 콘텐츠 주소 기반이며 project, GraphSnapshot, GraphSnapshot hash, SourceSnapshot identity와 비권위 프로젝션 flag를 기록합니다.

World Model indexing은 불변 World Model snapshot을 쓰고 검증한 뒤, graph projection을 구체화하고 다시 읽은 다음 World Model pointer를 전진시킵니다. 따라서 프로젝션 실패가 검증되지 않은 graph를 World Model의 현재 상태로 만들 수 없습니다. 이후 pointer 실패 전에 남겨진 projection snapshot은 무해한 파생 데이터이며 재사용 전에 다시 검증됩니다.

## Query 및 fallback 동작

Temporal traversal protocol `0.2.0`은 먼저 내장된 복구 가능 GraphSnapshot에서 결정론적 reference contract를 계산합니다. lexical discovery와 exact Lode-proposed anchor는 상호 배타적입니다. exact mode는 1~32개의 적격 node ID를 현재 GraphSnapshot에 결속하고 caller의 relation·authority·freshness·confidence·depth·node·edge·candidate policy를 확대할 수 없습니다. 현재 adapter query는 GraphSnapshot, query, result identity, ordering, bound, inclusion 및 exclusion reason을 포함해 canonical `TemporalTraversalResult`와 정확히 동일한 결과를 반환해야 합니다.

- 현재 adapter: adapter를 통해 query하고 semantic mismatch가 하나라도 있으면 거부합니다.
- 구체화된 adapter pointer가 없음: 내장 graph를 사용하고 `GRAPH_PROJECTION_NOT_MATERIALIZED`를 공개합니다.
- 프로젝션된 현재 GraphSnapshot이 다름: `GRAPH_PROJECTION_STALE`로 fail closed합니다.
- snapshot/pointer가 없거나, 손상되거나, 변조되었거나, 충돌함: fail closed합니다.
- backend 부재는 내장 graph를 제거하거나 semantic identity를 변경하지 않습니다.

reference 비교는 의도적으로 가속보다 정확성을 우선합니다. `PreparedTraversalRequest` 프로토콜 `0.1.0`은 이미 고정된 GraphSnapshot identity, 결정론적 TraversalQuery, 예상 result identity, 필터링되지 않은 정확한 bounded node/edge radius를 결속합니다. adapter는 콘텐츠에서 파생된 verification receipt를 반환하며, 권위 있는 semantic result를 반환하거나 선택하는 일은 절대 없습니다. provider-neutral client는 receipt 검증 후에도 자체 결정론적 reference result를 반환합니다.

## ArcadeDB 활성화 및 구체화

Onboarding은 ArcadeDB endpoint, database, environment 방식의 username/password reference name만 유지합니다. 선택만 한 상태는 configuration pending이며 remote I/O를 활성화하지 않습니다. 참조된 environment variable을 둘 다 사용할 수 있을 때 활성화는 명시적으로 수행됩니다.

```powershell
node scripts/lode.mjs world-graph-remote-database-status C:\path\to\project
node scripts/lode.mjs world-graph-remote-database-initialize C:\path\to\project
node scripts/lode.mjs world-graph-remote-activate C:\path\to\project
node scripts/lode.mjs world-graph-remote-status C:\path\to\project
```

Database status는 읽기 전용이며 endpoint·database name·credential value·record identity 없는 콘텐츠 기반 호환성 감사를 보고합니다. Initialization은 선택한 database가 없을 때 생성합니다. 무관한 기존 type은 activation을 차단하지 않으며 reset 사유도 아닙니다. 아홉 개의 `LodeAgentGraph*` 예약 type에 대해 kind·property·정확한 UNIQUE 키·관련 쓰기 제약을 확인하고, 관찰한 키와 제약을 감사 해시에 결속합니다. 누락된 type/property/index는 호환 가능한 부분 schema이지 activation 준비 완료 증거가 아닙니다. metadata를 확인할 수 없으면 미검증 상태이며 reset을 허용하지 않습니다. 예약 계약의 실제 비호환성이 입증돼도 전체 database reset은 `--reset-incompatible true`와 정확한 `--confirm-database`가 모두 있어야 가능합니다. 읽기 전용 조사와 비파괴적 수정도 대안입니다. Reset은 mutable pointer를 무효화하되 불변 영수증과 local graph mirror는 보존합니다. Activation은 graph 쓰기 전에 구축된 예약 schema를 검증합니다. 범용 migration이나 전체 버전 gate가 아닙니다.

Activation은 projection·topology·sync schema를 구축하고 현재 graph와 target을 비교해 콘텐츠 주소 기반 delta manifest를 씁니다. batch 기본 상한은 50개이며 최대 200개입니다. 정확한 record는 semantic identity를, snapshot-only 변경은 compact rebase record를, 새 내용이나 변경 내용은 전체 canonical JSON을 사용합니다. 매 호출은 checkpoint 유무와 관계없이 실제 batch 내용을 먼저 읽습니다. 정확히 일치하면 batch를 다시 쓰지 않고, 다른 내용은 conflict로 보존하며, 부분 반영이나 확인 불가는 unknown으로 남깁니다. checkpoint 부재는 미실행 증거가 아닙니다. 새 batch는 node UPSERT가 아닌 생성 전용 record와 필수 UNIQUE 키를 사용하므로 경쟁 insert를 덮어쓰지 않습니다. 응답 유실은 정확한 재조회로 대조하며 batch/SQL을 무조건 재시도하지 않습니다. 다른 transport도 이 adapter 보장을 지켜야 합니다.

최초 읽기의 header/body 통신 실패는 null 결과를 포함한 원격 관찰 이전에만 정확히 검증된 local mirror로 대체할 수 있습니다. 인증·잘못된 JSON·빈 성공 query 응답·무결성 오류·용량 제한은 이 fallback 대상이 아닙니다. JS와 Go 읽기 bridge는 모두 빈 성공 body를 거부합니다. 쓰기 응답 유실은 이미 반영됐을 수 있으므로 정확한 재조회로 입증하기 전까지 unknown입니다. local fallback이나 읽기 실패는 쓰기 재실행 권한이 아닙니다. 이는 운영 경계이지 Core-only 작업에 추가하는 gate가 아닙니다. 로컬 fixture 통과를 실제 ArcadeDB 정합성 검증으로 해석하지 않습니다.

모든 batch가 완료되면 activation은 전체 graph JSON을 remote에 중복 저장하는 대신 완전한 topology와 작은 topology-backed GraphSnapshot envelope를 쓰고 검증합니다. Baseline adapter equivalence와 prepared server-traversal conformance는 staged target pointer를 사용하므로 어느 pass도 candidate를 current로 만들 수 없습니다. 두 pass와 local recovery snapshot이 모두 성공한 뒤에만 단일 conditional pointer update가 기존 pointer를 정확히 관찰된 predecessor에서 전진시킵니다. 초기 pointer는 project-unique index를 compare-and-insert fence로 사용합니다. 결과는 다시 읽히며, predecessor가 다르면 fail closed하고, 동일한 target이 이미 설치된 경우 멱등적으로 수락합니다. 그런 다음 local pointer가 이를 원자적으로 mirror합니다. `.lode/graph-projection/arcadedb/sync/receipts`는 manifest, checkpoint set, prior/final pointer, 전체 snapshot/topology verification, local recovery 및 atomic transition을 결속하는 콘텐츠 기반 receipt를 기록합니다. Credential value, endpoint, target name, server record identity, timing은 계속 제외됩니다.

local canonical GraphSnapshot은 독립적인 recovery source로 유지됩니다. remote topology-backed envelope는 snapshot 범위의 vertex와 edge로부터 정확히 그 graph를 재구성하며 count, set-digest, topology, byte-length 또는 full-content mismatch를 거부합니다. 모든 vertex는 정확한 semantic node JSON을 저장하고 모든 edge는 정확한 semantic edge JSON을 저장하는 반면, ArcadeDB record ID는 operational detail로 남습니다. topology manifest는 project, GraphSnapshot, SourceSnapshot, 정렬된 node 및 edge set digest, count, non-authority flag를 콘텐츠 기반 identity에 결속합니다. Unique index는 vertex와 edge를 `(projectId, graphSnapshotId, semanticId)`에 결속하지만 해당 database index를 semantic identity로 만들지는 않습니다.

활성화된 query mode는 `server-expanded-client-canonicalized`로 유지됩니다. 새로 conformance를 통과한 activation은 prepared traversal `0.1.0`을 알립니다. Query execution은 내장 GraphSnapshot에서 결정론적 reference를 로컬로 계산하고, 현재 remote pointer와 topology manifest를 검증한 다음, ArcadeDB에 breadth-first `TRAVERSE`로 준비된 snapshot 범위 radius만 확장하도록 요청합니다. 전체 remote snapshot이나 완전한 vertex/edge topology를 다시 불러오지 않습니다. 하나의 semantic hop은 두 단계의 physical traversal depth(vertex에서 edge로, 다시 vertex로)이며, depth는 0부터 3까지의 범위로 유지되고 response는 8,192개 record로 제한됩니다. overflow 탐지에만 record 하나를 추가로 사용합니다.

prepared-query inspection에서 검증된 pointer는 해당 `ArcadeDbGraphProjectionAdapter` instance에 결속된 non-serializable object token을 통해 바로 다음 synchronous query에서 정확히 한 번 재사용됩니다. token은 credential, cache, receipt, semantic field 또는 persistent artifact가 아닙니다. token이 없거나 foreign, invalid 또는 이미 consumed 상태이면 일반적인 remote pointer read를 수행하며, 그 경우에도 pointer document를 완전한 prepared GraphSnapshot identity와 대조합니다. 이는 중복 round trip만 제거합니다. query를 넘어 freshness를 연장하거나 caller가 current state를 단정할 수 있게 하지는 않습니다.

그 독립적인 pointer check 이후에는 topology-manifest read와 bounded traversal이 query-only exact-child batch 하나를 사용합니다. JavaScript child가 reference implementation입니다. 별도의 Go child는 검증된 native distribution의 콘텐츠 주소 기반 platform manifest에서 선택된 경우에만 사용할 수 있습니다. 이 child는 동일한 environment-reference name을 해석하고 write operation을 허용하지 않으며 신뢰되지 않는 response envelope를 반환합니다. native artifact가 없으면 JavaScript batch를 사용합니다. Native startup, invalid-output 또는 선택 후 binary-integrity failure가 발생하면 operational diagnostics와 함께 reference path로 fallback하지만, 설치된 manifest가 유효하지 않으면 fail closed합니다. computation worker는 계속 network-forbidden 상태입니다. GraphDB access는 이 transport boundary에만 속합니다.

server response는 evidence이지 semantic authority가 아닙니다. client는 정확한 prepared radius를 요구하고 모든 JSON record와 physical traversal depth를 검증하며, stale manifest, 누락된 coverage, duplicate, forged 또는 radius 밖의 record, truncation을 거부합니다. 그런 다음 변경되지 않은 결정론적 `TemporalTraversalResult`를 반환합니다. server ordering, ArcadeDB record ID, transport metadata, verification receipt는 query 또는 result identity에 절대 포함되지 않습니다. 이는 query 범위의 integrity입니다. status inspection과 activation은 여전히 전체 remote snapshot/topology verification을 수행하므로, 요청한 radius 밖의 corruption은 bounded query가 존재하지 않는다고 주장하는 대신 그 full-audit path에서 탐지됩니다.

## Prepared traversal 성능 evidence

`PreparedTraversalCostEvidence` 프로토콜 `0.1.0`은 정확한 GraphSnapshot과 `PreparedTraversalRequest`에서 콘텐츠 기반으로 파생됩니다. 그 payload model은 정규화된 UTF-8 canonical-JSON response component인 identity envelope, graph manifest, bounded expansion, complete GraphSnapshot, complete topology record를 계산합니다. prepared total에는 identity envelope, manifest, bounded expansion만 포함됩니다. 보수적인 full-reload baseline은 complete snapshot 하나와 complete topology record set 하나를 추가합니다. 이는 재현 가능한 logical transport-cost evidence이지 HTTP framing, compression, database cache state 또는 wall-clock latency에 관한 주장이 아닙니다.

`benchmarks/prepared-traversal-v1` 아래의 검토된 64-file fixture는 graph, request, result, cost-evidence identity를 고정합니다. GraphSnapshot에 P1-P5 권위 경계와 현재 summary field를 포함한 상태에서 prepared bytes 20,491 대 baseline 836,589 bytes를 기록하여 816,098 bytes, 즉 9,755 basis points를 절감합니다. 다음 명령으로 실행합니다.

```text
npm run benchmark:prepared-traversal -- --iterations 7
```

Elapsed time과 관찰된 transport-call size는 diagnostics에만 출력되며 `PreparedTraversalCostEvidence`, graph, query, result 또는 Capsule identity에는 절대 포함되지 않습니다. fixture는 full snapshot read 0회, full topology read 0회, query-phase write 0회를 검증합니다.

이미 prepared ArcadeDB가 활성화된 project에서는 동일한 harness를 엄격한 read-only mode로 사용할 수 있습니다.

```text
npm run benchmark:prepared-traversal -- --live-project <project-path> --iterations 7
```

live path는 project 범위의 activation과 environment reference name을 읽고, credential value 또는 credential flag를 허용하지 않으며, fallback과 semantic drift를 거부하고, 모든 schema/snapshot/topology/pointer write method를 fail-closed guard로 대체합니다. report는 endpoint, database, credential value, project path를 제외합니다. fixture run은 계약과 결정론적 cost identity를 증명합니다. live environment에 대한 동작과 latency를 증명하는 것은 성공한 `arcadedb-live-read-only` report뿐입니다.

2026-08-20의 privacy-safe live acceptance는 이미 검증된 node 8,037개, edge 12,441개의 project graph를 사용했습니다. 동일한 prepared traversal 7회는 full-reload baseline의 23,101,697 bytes 대신 정규화된 220,930 bytes를 처리하여 22,880,767 bytes, 즉 9,904 basis points를 절감했습니다. 모든 run은 정확한 graph, request, query, result identity를 유지했으며 query-phase write, full snapshot read, full topology read는 계속 0회였습니다. 첫 run은 end-to-end 2,942.2 ms, bounded database expansion 134.7 ms를 측정했습니다. 중복 pointer read와 불필요한 receipt 작업을 제거한 뒤 fresh completion run은 동일한 semantic 및 byte identity를 유지하면서 end-to-end median 2,820.4 ms, database-expansion median 137.7 ms를 기록했습니다. timing은 semantic evidence가 아니라 diagnostics로 남습니다.

동일한 completion acceptance는 선택된 live database의 전용 project namespace에서 새로운 write path도 실행했습니다. production 규모인 8,037/12,441 projection은 predecessor/target pointer가 동일한 zero-batch no-change sync를 통과했고, snapshot/topology/local mirror가 검증되었으며 불변 receipt가 생성되었습니다. 별도의 small fixture는 initial upload, four-batch delta, checkpoint 하나 뒤의 interruption, checkpoint resume, stale-predecessor pointer-conflict rejection, conflict recovery를 통과했습니다. 또한 acceptance 전에 세 가지 transport defect를 드러내고 수정했습니다. 유효한 대용량 response 후 bridge 강제 종료, CAS에서 server-reserved variable을 사용한 SQLScript, endpoint 기반 `IF NOT EXISTS`가 서로 다른 parallel semantic edge를 억제한 문제입니다. acceptance namespace는 정확히 제거되었고 남은 record가 0개임을 검증했습니다. 아홉 개 reserved type과 무관한 record는 보존되었습니다.

중단된 sync는 digest로 검증된 manifest와 불변의 검증된 checkpoint에서만 재개됩니다. checkpoint가 없는 batch는 안전하게 replay할 수 있지만, 충돌하는 manifest, checkpoint, batch record, complete topology 또는 pointer predecessor는 조용히 복구하지 않고 fail closed합니다.

activation 후 기본 adapter는 성공한 모든 remote snapshot과 pointer를 local JSON projection에 mirror합니다. connection/timeout 또는 missing-environment-reference failure가 발생하면, 해당 operation에서 remote content를 관찰하거나 변경하기 전에만 local mirror를 선택할 수 있습니다. Authentication failure, rejected request, stale pointer, missing record, digest mismatch, content conflict, semantic query divergence 또는 remote observation/mutation 이후의 failure는 fail closed합니다. remote outage 중 local progress가 발생하면, 이후 stale remote pointer 역시 명시적인 activation이 projection을 복구하고 재검증할 때까지 fail closed합니다.

## 활성 adapter와 표면

- `LocalJsonGraphProjectionAdapter`: 의존성 없는 durable baseline입니다.
- `InMemoryGraphProjectionAdapter`: non-durable conformance implementation입니다.
- `ArcadeDbGraphProjectionAdapter`: resumable content-addressed delta batch, immutable checkpoint, snapshot-scoped vertex/edge topology, topology-backed snapshot reconstruction, pointer compare-and-swap, full query-time reload 없는 선택적 conformance-gated prepared bounded expansion을 갖춘 authenticated ArcadeDB HTTP/JSON durable projection입니다.
- `ActivatedArcadeDbGraphProjectionAdapter`: 완전한 local mirror와 좁게 분류된 pre-observation availability fallback을 갖춘 remote-first adapter입니다.
- `verifyGraphProjectionAdapterConformance`: authority-bounded adapter 둘을 모두 명시하고, 하나의 GraphSnapshot 및 이름이 지정된 1~64개의 bounded query fixture에서 adapter-neutral semantics를 증명하는 콘텐츠 기반 report입니다.
- `world-graph-status`: projection state를 읽고 검증합니다.
- `world-graph-remote-activate` 및 `world-graph-remote-status`: 명시적인 activation 및 read-only remote status입니다.
- `world-graph-remote-database-status` 및 `world-graph-remote-database-initialize`: read-only compatibility audit 및 명시적인 exact-target provisioning/reset boundary입니다.
- `lode_graph_projection_status`: read-only MCP equivalent입니다.
- `lode_graphdb_projection_status` 및 `lode_graphdb_database_status`: read-only MCP activation 및 compatibility status equivalent입니다.
- `world-temporal`, MCP temporal traversal, Context Compiler temporal expansion은 result identity를 보존하면서 adapter boundary를 사용합니다.
- 별도의 [`DocumentProjectionAdapter`](document-projection-adapter.md)는 graph identity를 변경하지 않고 결정론적 Markdown 생성을 위해 검증된 GraphSnapshot을 사용합니다.

## 향후 과제

- 범위가 제한된 결정론적 기본값을 넘어서는 adaptive concurrency 및 측정 기반 batch-size tuning
- 독립적인 trust-boundary check를 보존하는 새로운 측정 bottleneck이 있을 때에만 수행하는 추가 local canonical-verification amortization
- ArcadeDB가 아닌 GraphDB transport
- asynchronous pooled remote transport, retry/backoff 및 transport amortization
- compute-backed graph construction 또는 traversal
- topology schema migration 및 operational observability
- Obsidian/Notion document adapter

자동화된 test는 in-memory transport를 사용하며 user GraphDB를 요구하거나 변경하지 않습니다. Database initialization과 graph activation은 명시적인 remote mutation surface 두 가지뿐이며, 어느 쪽도 credential value를 argument로 받지 않습니다.

선택적인 ArcadeDB native read bridge는 Go computation worker가 아니라 별도의 exact child입니다. `LODE_AGENT_ARCADEDB_NATIVE_MODE=auto|off|required`는 runtime availability policy를 선택합니다. native capability가 없을 때 JavaScript reference exact child를 사용할 수 있는 것은 `auto`뿐이며, 선택된 binary 또는 manifest의 integrity drift는 모든 mode에서 fail closed합니다. 두 exact child 모두 구성된 username/password reference value와 범위가 제한된 operational environment만 받습니다. Go bridge는 redirect를 거부하고, 전체 batch에 하나의 deadline과 하나의 aggregate wire budget을 적용하며, ArcadeDB query endpoint에서 SELECT query만 노출합니다. Parent-side canonical graph 및 receipt validation은 변경되지 않습니다.

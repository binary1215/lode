# 아키텍처 결정

> 영어 원문: [`../architecture.md`](../architecture.md)

## 채택한 형태

플러그인은 공급자 중립적 Core를 둘러싼 얇은 공급자 배포판으로 구성됩니다.

```text
.codex-plugin/plugin.json
  -> skills/lode-agent-core       human/agent operating contract
  -> .mcp.json                    read-only inspection surface
  -> scripts/lode.mjs             explicit mutation entrypoint
       -> scripts/lib/lode-core   project canon and projections
       -> scripts/lib/session-routing independent logical Session routing
       -> scripts/lib/project-direction common current user direction
       -> scripts/lib/project-graph bounded graph-first discovery
       -> scripts/lib/context-compiler
                                  versioned task Context Capsules
       -> scripts/lib/execution-lineage
                                  content-derived lineage artifacts
       -> scripts/lib/run-lineage contract-bound Run state transitions
       -> scripts/lib/product-model user-owned product-intent canon contract
        -> scripts/lib/onboarding project-scoped bootstrap, candidate, review, and promotion state machine
             -> scripts/lib/onboarding-contract Session, storage, and state-pointer identity contract
             -> scripts/lib/onboarding-projection immutable onboarding artifact validation and graph input
       -> scripts/lib/compute-adapter backend-neutral compute and WorkerProtocol contract
       -> scripts/lib/world-model incremental repository view
            -> scripts/lib/semantic-graph evidence-linked semantic projection
            -> scripts/lib/temporal-provenance immutable revision DAG and bounded traversal
            -> scripts/lib/git-history replaceable Git evidence source
            -> scripts/lib/runtime-state replaceable runtime evidence source
            -> scripts/lib/world-model-store replaceable storage contract
```

Claude Code, Codex 및 OpenCode는 동일한 `.lode/` 권한의 프로젝션입니다. 각각 별도의 프로젝트 진실을 소유하지 않습니다.

작은 하위 경계로 원본 소비자와 효과 orchestration의 결합을 줄입니다.
`session-paths`는 라우팅과 공통 방향에 경로 제한을 제공하고,
`product-policy-records`는 그래프 투영에 불변 Policy 검증·reader를 제공합니다.
`runtime-invocation-storage`는 원본의 배타적 게시만 맡으며,
`worker-patch-proposal-contract`는 런타임 실행 없이 제안 검증을 제공합니다.
기존 공개 모듈은 이전 계약을 reexport합니다. 원본 identity와 권한은 같고
나머지 World·refresh·운영 루프 의존은 남아 있습니다. 실행 속도가 개선됐다는
주장은 아닙니다.

소스 트리는 직접 실행 가능한 Core로 유지됩니다. CI는 신규 Lode 설치용 `lode-codex-marketplace` 및 `lode-claude-marketplace` 브랜치를 게시하면서 기존 `codex-marketplace`와 `claude-marketplace`에는 HEAD 설치 식별자를 계속 제공합니다. 각 브랜치는 플러그인 하나와 그 이름 한 벌만 포함하며, 기존 설치를 자동 전환하거나 이중 등록하지 않습니다. CI는 동일한 허용 목록 배포판에 검증된 빌드 매트릭스에서 조립한 5개 플랫폼용 단일 네이티브 번들을 오버레이합니다. 이 번들은 버전과 커밋에 바인딩됩니다. 런타임 선택은 정확한 호스트 일치와 무결성 검증을 통과해야 하며, 다른 대상은 비활성 배포 바이트로 남습니다. Claude의 생성 브랜치는 Claude Code에 필요한 카탈로그, 플러그인 매니페스트 및 `${CLAUDE_PLUGIN_ROOT}` MCP 캐시 경로 프로젝션만 추가합니다. 배포 메타데이터, 네이티브 바이너리 및 캐시 경로는 Core ID, Product Canon, Session/Run 복구 또는 어떤 authority plane도 변경할 수 없습니다. [`codex-marketplace.md`](codex-marketplace.md)와 [`claude-marketplace.md`](claude-marketplace.md)를 참조하세요.

## 헌법적 Core와 선택적 프로필

안정적인 규범적 기반은 [`lode-constitution.md`](lode-constitution.md)에 있는 작은 공급자 중립적 Lode 헌법입니다. P1-P5는 강제 가능한 내부 타입 시스템이지, 사용자가 반드시 거쳐야 하는 의식이 아닙니다. 공개 초기화/재개 트랜잭션은 별도의 프로젝트 ID를 만들지 않고 두 가지 프로필을 노출합니다.

- `core`가 기본값이며 정식 Project, 선택된 논리 Session, 공급자 투영과 적격한 기존 관측 색인을 보존합니다.
- `product`는 증거가 연결된 온보딩과 Product/World/Graph 거버넌스 경로를 명시적으로 활성화하거나 재개합니다.

두 프로필은 동일한 Core 트랜잭션, Project ID, Session ID, 관리형 설치 수렴 및 권한 계약을 사용합니다. Core 재개는 이미 활성화된 Product 프로필을 삭제하거나 자동으로 새로 고치지 않습니다. `product`를 명시적으로 선택하지 않으면 온보딩 입력은 거부됩니다. 공급자 어댑터가 서로 다른 선택적 기능을 노출할 수는 있지만, 어느 어댑터도 이러한 의미 체계를 재정의할 수 없습니다.

따라서 `profile`은 영속적인 프로젝트 모드가 아니라 작업 선택입니다. 읽기 전용 `LodeProjectExperienceProjection`은 Core 준비 상태와 Product 준비 상태를 독립적으로 보고하고, 실행 가능한 다음 단계 하나를 선택하며, Context 컴파일, 영속적 Runs, 범위가 한정된 workers, 컴팩션 복구 및 공급자 호출의 전제 조건을 공개합니다. 이 프로젝션은 범위가 한정되고 비영속적이며 권한이 없습니다. 검사는 기능을 활성화하거나, 관리되는 파일을 복구하거나, Run 또는 ReviewDecision을 생성하거나, 임대를 소비하거나, 복구 방향을 기록할 수 없습니다. CLI `status`/`doctor`와 MCP `lode_project_status`는 동일한 프로젝션을 반환합니다. 검증된 온보딩 상태는 계속 내장되므로 친절한 안내가 정식 상태 머신을 대체하지 않습니다.

같은 프로젝션은 `readiness.recovery`를 사실 기반의 읽기 전용 안내로 공개합니다.
`no-current-checkpoint`에서는 일반 Session 작업을 계속할 수 있고,
`verified-current-checkpoint`는 아티팩트 전용 복원이 성공했다는 뜻이며,
`attention-required`는 영향을 받은 복구 경로에만 수정이 필요함을 공개합니다.
이 필드를 읽어도 컴팩션 continuation을 소비하거나, 공급자를 연결하거나, P2 방향을
기록할 수 없습니다.

대화 진입은 읽기 전용 `lode_conversation_enter`를 통해 같은 검증을 구성하고,
범위가 한정된 프로젝트 상태, 통합 Attention, 패키지 버전 및 표시 투영을 한 번에
반환합니다. 이 P4 스타일 view는 저장 큐나 gate를 추가하지 않습니다.
`userDecisionRequired`는 보호되는 사용자 결정에만 사용하고,
`headActionRequired`는 내부 후속 조치를 Lode에 배정하며, 각 항목은 영향을 받는
작업을 명시합니다. 일반 작업은 기본적으로 계속할 수 있습니다.
대기 중인 선택적 Product 작업은 `when-product-governance-is-in-scope`로 표시하며,
그 존재만으로 대화 진입을 즉시 필요한 사용자 결정으로 바꿀 수 없습니다.
별도의 선택적 P5 `CompactionLifecycleHostAdapter`는 journaled pre/post-compaction
및 provider-replacement event를 전달하고 raw continuation token을 project Canon
밖에 보관하며 bounded provider outcome만 보고할 수 있습니다. Core는 verify나
continuation보다 P2를 먼저 복원합니다. Adapter는 provider-session identity를
담거나 recovery, instruction, review, promotion 또는 Product Canon을 작성할 수
없습니다. Adapter 부재는 project-readiness failure가 아니라 일반 작업을 막지
않는 capability gap입니다.

## 공통 방향, Session과 탐색

하나의 정식 Project에 현재 공통 사용자 방향과 독립적으로 라우팅되는 Session이
있습니다. 각 Session은 목적, 진행, 체크포인트와 활성·불명 작업을 보존합니다.
요청별 routing은 `.lode/sessions/current.json`을 기본 기록으로 유지하며 다른
Session은 `.lode/sessions/by-id/<session-id>/current.json`을 사용합니다.
논리 Session ID는 공급자 session ID가 아닙니다. 프로젝트 범위 온보딩의 기존
검토 계보도 유지합니다.

`ProjectDirection`은 P2 현재 사용자 방향으로, 불변 revision과
`.lode/project-direction/current.json` 포인터에 저장합니다. 정확한 기준의
compare-and-swap으로 경합한 쓰기가 시각이나 마지막 쓰기만으로 덮어쓰지 못하게
합니다. 과거 checkpoint 필드는 그대로 보존하고 현재 공통 방향을 별도로
제공하므로 더 최신인 공통 제약이나 취소된 작업을 되돌리지 않습니다.
방향 기록 자체가 실행 authorization을 부여하지도 않습니다.

`lode_project_graph`는 제한된 P4 관측 색인과 선택적 보존 World 층을 조회합니다.
작업과 Product 관점은 공통 원본을 참조합니다. 관계 확장에서도 리비전·기준,
무결성, 최신성, 확인 범위, 출처와 원래 후보·거절 상태를 유지합니다.
온전한 과거 자료는 읽을 수 있고 손상된 층만 제외합니다. 빈 결과나 부분 범위는
사실 부재를 뜻하지 않습니다. 동일 기준의 결과와 알려진 실패를 재사용하고
그래프·adapter 손실 시 원본으로 진행합니다. 전체 World current, Product 검토,
Run/Capsule, 색인 완료나 DB는 일반 탐색의 gate가 아닙니다. 변경 없는 색인을
재사용하며 조회는 체크포인트, 승인, 후보나 매번의 receipt를 만들지 않습니다.
실제 효과는 현재 원본과 권한을 다시 확인합니다.
[탐색 참고 문서](../../skills/lode-agent-core/references/project-discovery.md)를 참고하세요.

직접 작업, 일반 Host 위임과 관리형 실행은 수단 선택입니다. 새로운 유용한
복구·효과 추적 작업에 관리형을 선택할 수 있지만 파일 수정, worker 수나 일반
실패만으로 강제하지 않습니다. Fork/fresh는 별도 맥락 선택이며 승인, 격리나
cache를 보장하지 않습니다.

## 온보딩 authority plane

초기화는 공급자 대화와 독립적인 기본 Session과 온보딩 포인터를 보존하고 경량 기존 관측 색인을 갱신합니다. 명시적인 `product` 범위에서만 관리되는 로컬 World Model을 구성합니다. 구조화된 user brief는 candidate를 직접 seed할 수 있고, 그 외에는 fresh provider Lode가 현재 evidence에서 bounded semantic proposal을 작성합니다. JavaScript Core는 정확한 SourceSnapshot, path, digest, line, optional symbol, Product Model reference와 bound를 검증한 뒤 하나의 immutable batch를 제시합니다. Core는 lexical product inference를 하지 않으며 proposal에는 지시 또는 승격 권한이 없습니다.

명시적인 사용자 결정으로 작성되고 `decisionScope: product-canon-bootstrap`이 지정된 `ReviewDecision`만 Product Canon revision을 생성할 수 있습니다. CLI와 typed `lode_onboarding_review`는 동일한 exact-candidate 검증을 Core에 위임하며, 라우팅이나 도구 탐색이 사용자 승인을 공급하지 않습니다. 수락 시 이전 및 다음 Product Model 해시를 기록하고, 자식 SourceSnapshot을 재구축하며, 상태 포인터가 준비 상태가 되기 전에 temporal GraphSnapshot을 검증합니다. revision은 후속 후보 집합을 생성하고, 거부 시 Canon은 변경되지 않습니다. 불변 candidate, Evidence, Unknown, ReviewDecision 및 ProductModelRevision 영수증은 감사를 위해 그래프에 프로젝션되지만, 프로젝션 자체는 결정하거나 승격할 수 없습니다. 읽기 전용 상태·그래프 작업은 검토하거나 승격할 수 없습니다.

스토리지 선택의 기본값은 완전한 로컬 경로입니다. GraphDB endpoint, database 및 환경 스타일 secret-reference 이름은 보류 중인 운영 구성으로 기록할 수 있지만, 자격 증명은 거부되며 어댑터가 적합성 검사를 통과하기 전에는 원격 성공을 주장하지 않습니다. [`onboarding.md`](onboarding.md)를 참조하세요.

## 이전 런타임을 내장하지 않는 이유

기존 구현은 프로젝트 권한을 실행 중인 Herdr 창과 OpenCode 세션에 바인딩하고, POSIX 서비스를 설치하며, Unix 중심의 경로와 프로세스 가정을 사용합니다. 그 런타임을 Codex 플러그인에 복사하면 크로스 플랫폼 지원을 거짓으로 내세우고 정리 및 펜싱 불변 조건을 약화하게 됩니다.

런타임 계층은 `PlatformAdapter`, `AgentRuntimeAdapter`, `WorkspaceHostAdapter`
경계를 유지합니다. capability 관찰은 실행 권한을 부여하지 않습니다.
관리형 invocation은 at-most-once 소유권, 범위, 취소와 정리를 유지하고,
일반 Host 위임은 Lode 역할 token·generation·inbox·target chain 없이
기존 Host 기능을 사용합니다. 현재 사용자 방향과 실제 unknown effect는 보존합니다.

선택적 endpoint attachment는 P2를 먼저 복원하고 현재 Host snapshot과 process
소유권 proof를 사용합니다. portable export bridge는 현재 snapshot 하나만 보존하며
delivery mail service가 아닙니다. Host 손실 시 같은 canonical logical Lode로
fallback합니다. 이전 live role-message test는 과거 증거이지 새 경량 경로 검증이 아닙니다.
provider resume/stream과 Host별 pane/socket/TUI 변환은 Core 밖에 둡니다.
[런타임 어댑터](runtime-adapters.md)를 참고하세요.

## 파일 소유권

`.lode/`는 플러그인이 관리하는 Canon입니다. 루트 `CLAUDE.md`, `.mcp.json`, `AGENTS.md`, `opencode.json`은 독립적으로 소유되는 프로젝션입니다. 없는 파일만 생성할 수 있고 기존 프로젝트 소유 파일은 보존하며 대안은 `.lode/generated/`에 둡니다. 검증된 Claude 플러그인 MCP 연결은 중복 프로젝트 설정을 만들지 않습니다. 패키지 클라이언트는 `node`, 프로젝트 상대 `scripts/mcp-server.mjs` 또는 placeholder(`${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`, `{env:LODE_PLUGIN_ROOT}`)를 사용합니다. standalone Claude 초기화는 검증된 로컬 launcher나 정확한 절대 패키지 경로를 쓸 수 있습니다. 이 경로는 기기에 종속되지만 절대 Node 바이너리를 넣지는 않습니다. [런타임 실행 경로](runtime-adapters.md#시작-안내와-claude-파일-소유권)를 참고하세요.

관리되는 매니페스트는 SHA-256 다이제스트를 기록합니다. 관리 대상의 드리프트가 감지되면 정식 변경이 중단됩니다.

## Context Compiler plane

Context Compiler는 정식 프로젝트 지식과 Lode 실행 사이에 위치합니다. 범위가 한정되고 재현 가능한 `ContextCapsule`을 컴파일하며, 두 번째 권한이 되지는 않습니다.

`ContextWorkflowProjection`은 선택 맥락에 대한 비영속 P4 안내입니다.
출처, 누락과 불확실성을 Lode 판단에 제공하며 포함 증명이나 고정 token tier를
요구하지 않습니다. preview 한 번은 selection 한 번입니다. Lode가 원본 증거를
검사하거나 유용한 anchor를 확대할 수 있지만 실행 권한 부여, provider 호출이나
복구 방향 쓰기는 수행하지 않습니다.

같은 workflow에는 비영속 `ContextExplanationCard`가 포함됩니다. 포함된 증거를
종류별로 묶고, Compiler가 이미 기록한 사유별 의도적 제외와 남은 불확실성을
요약합니다. 기존 Capsule 결과를 설명할 뿐 EvidenceNeed를 추가하거나 selection,
budget, 의미적 충분성의 소유권 또는 권위를 바꾸지 않습니다.

그 앞의 `ContextPreparationProjection`은 정확한 사용자 task로부터 선택 맥락을
반환하며 추가 tool round trip을 요구하지 않습니다. World 부재·오래됨은 공개하되
현재 source를 직접 사용할 수 있습니다. 선택적 Lode 안내는 정확한 출처 결속을
검증하며 어휘 ranking은 의미 판단이나 후보 자격 gate가 아닙니다.

```text
Canonical sources -> Snapshot -> Lode EvidenceNeeds -> verified packing/budget -> ContextCapsule -> Lode/Executor
       ^                                                        |
       |             verified candidate knowledge               |
       +--------------------------------------------------------+
```

World Model과 Capsules는 구체화된 뷰입니다. 증거와 Project Canon으로부터 재구축할 수 있어야 합니다. `Snapshot`, `Evidence`, `Claim`, `Decision`, `Unknown` 및 `ContextCapsule`은 의미 경계이며, 스토리지 기술은 교체 가능한 상태로 유지됩니다.

Compiler를 사용할 수 없는 상황은 어댑터 수준의 fail-open 조건입니다. ID 드리프트, Canon 드리프트, 유효하지 않은 지식 또는 Capsule 다이제스트 불일치는 Core의 fail-closed 조건입니다.

## Execution Lineage plane

Execution Lineage는 공급자 대화를 권한으로 삼지 않고 Capsule을 감사 가능한 전체 계획 루프로 전환합니다.

```text
WholePlanSnapshot
  -> ExecutionContract + ContextCapsule
  -> Executor
  -> ResultPacket
  -> ReviewDecision
  -> accepted result or refined WholePlanSnapshot
```

각 아티팩트에는 콘텐츠에서 파생된 ID, 다이제스트 검증 및 타입이 지정된 `LineageLink` 부모가 있습니다. `ResultPacket` 증거는 명시적으로 지시 권한이 없습니다. Fresh Lode는 숨겨진 모델 세션을 재개하는 대신 이러한 검증된 아티팩트에서 검토 컨텍스트를 재구성합니다.

이제 아티팩트 전용 Session 복원은 정확한 콘텐츠 주소 지정 `SessionRunCheckpoint`, 불변 Session 포인터 및 검증된 Run/plan/contract/Capsule 리니지로부터 현재 소비자 입력을 재구성합니다. 반환되는 `SessionRestoreProjection`은 비영속 P4이며 공급자 세션 ID, 트랜스크립트, 요약, resume 또는 stream을 사용하지 않습니다. Fresh Lode ReviewDecision이 수락된 후 별도의 일회성 작업은 검토된 Run을 복구 필드가 명시적인 Lode/사용자 입력인 P2 체크포인트에 바인딩할 수 있습니다. ResultPacket과 과거 P3 통합 영수증은 그 방향을 작성하거나 대체할 수 없습니다.
새 통합은 별도 request/receipt 파일 없이 checkpoint 자체에 정확한 수락 계보를 기록합니다. [`session-recovery.md`](session-recovery.md)를 참조하세요.

공급자 중립적인 실행 wave 가시성은 기존 HF-009 디스패치 위에 구성된 별도의 P3/P4/P5 조합입니다. `BoundedWorkerWave`는 권한 부여를 생성하거나 확대할 수 없습니다. 명시적 seal에는 모든 독립적 임대 소비가 필요합니다. status/results는 P4 뷰로, wait는 P5로 유지됩니다. 구성원별 authorization·lease·result evidence는 독립적으로 보존합니다. 여러 worker가 참여한 Run은 Lode가 통합 결과를 평가해 하나의 전체 Run ResultPacket을 게시하고, 그 전체 결과에 대해 Fresh Lode 검토·명시적 ReviewDecision·HF-010 체크포인트 통합을 거칩니다. 구성원마다 이 전이를 별도로 수행하지 않으며 wave 완료 자체는 어떤 전이도 실행하지 않습니다. [`bounded-worker-wave.md`](bounded-worker-wave.md)를 참조하세요.

Checkpoint 최신성은 정확한 현재 P2 identity와 Run/compaction 전이 상태를 포괄하는
비지속 읽기 전용 basis를 사용합니다. Provider Lode가 자연어 방향을 도출하고, Core는
기존 mutation lock 안에서 그 basis를 다시 검증해 checkpoint 게시를 create, reuse,
defer 또는 conflict로 처리할 뿐입니다. 동일 retry는 ledger나 pointer를 추가로 쓰지
않습니다. P3/P4/P5는 방향을 작성하지 않고, open compaction을 대체하지 않으며,
accepted-result binding은 기존 reviewed-Run integration transaction만 소유합니다.
[`session-recovery.md`](session-recovery.md#최신성-gate를-적용한-checkpoint-동기화)를 참조하세요.

checkpoint 진단은 그와 분리된 비지속 P4 projection이며, 검증된 두 basis 읽기 사이에서
artifact restore를 수행합니다. pointer 존재, restore 검증, 기계적인 sync 가능 여부와 다음
Lode 동작을 cache, lock, repair 또는 model 호출 없이 보여 줍니다. 안정적인 identity는 의미적
최신성을 증명하지 않습니다. 순차 읽기는 원자적 snapshot이 아니며 ABA를 감지할 수 없습니다.
integrity 실패, 필수 reference drift, pointer가 가리키는 artifact 누락과 선택적 P3
ResultPacket 누락은 구별됩니다. 프로젝트 준비도와 대화 진입은 현재 pointer가 있을 때 이
계약을 재사용하고, pointer가 없는 fast path는 저비용 일반 작업 사실로 남습니다. CLI와
typed MCP는 요청 시 전체 진단을 노출합니다.

버전 0.3 alpha는 Runs를 검증된 계약에 바인딩하고, 완료를 ResultPacket으로 변환하며, 결정론적인 최소 Fresh Lode 검토 프로젝션을 구성하고, 수동 Lode ReviewDecision에 그 정확한 프로젝션을 요구합니다. `revise`와 `expand`는 다른 Run에 앞서 ReviewDecision에 연결된 다음 WholePlanSnapshot을 요구합니다. 후보 지식과 Lode 권고에는 계속 권한이 없습니다. 정확한 선택적 WorkspaceHost 연결은 P2 복원 후에만 활성화됩니다. 일반 공급자 resume/stream, 더 광범위한 런타임 제어 및 권한이 부여된 지식 승격 표면은 계속 연기됩니다.

## Repository World Model plane

World Model은 지원되는 저장소 파일, 휴리스틱 심볼, 종속성, import 및 해석 가능한 호출을 콘텐츠 주소 지정 증거로 구체화합니다. 선택적인 provider-neutral `SourceRelationEvidenceAdapter`는 정확한 현재 file manifest에 결속된 언어 AST `IMPORTS`/`CALLS` 증거를 추가할 수 있습니다. Core는 이를 heuristic fallback과 분리된 analyzer·source·confidence로 보존합니다.

`WorldModelStoreAdapter`는 World Model 영속성을 의미적 스냅샷 ID와 분리합니다. 스냅샷에는 불변의 재구축 가능한 스토리지 계약만 포함되며, 포인터는 활성 어댑터 descriptor를 기록합니다. 로컬 JSON 어댑터가 활성화되어 있고, 메모리 내 적합성 테스트는 동일한 정식 입력이 다른 어댑터를 통해서도 동일한 World Model ID를 생성함을 입증합니다.

`IncrementalRefreshRequest`와 `IncrementalRefreshReceipt`는 명시적 인덱싱 이후의 관찰 상태 새로 고침을 확립합니다. 새로 고침은 대상이 되는 모든 파일을 다시 발견하고 바이트 해시하며, 다이제스트가 동일한 파일에 대해서만 검증된 분석을 재사용하고, 전체 참조 경로와 동일한 `RepositoryScanResult`를 생성해야 합니다. 실제 변경이 있으면 검증된 현재 SourceSnapshot을 자동으로 부모로 삼고, 변경되지 않은 revision ID를 보존하며, 변경된 revision의 부모를 이전의 현재 revision으로 지정하고, 그래프 구체화를 검증한 뒤, 미리보기 ID가 확정된 후에만 World Model 포인터를 전진시킵니다. 활성 Runs는 정확한 Capsule과 계약을 유지합니다. 영수증은 드리프트와 필요한 명시적 Lode 선택을 기록합니다. Product Canon과 검토된 관계는 변경되지 않습니다. [`incremental-refresh.md`](incremental-refresh.md)를 참조하세요.

`RefreshTriggerBatch`와 `RefreshTriggerDeliveryReceipt`는 다음 수집 계층을 추가합니다. 포그라운드 재귀 파일시스템 watcher와 엄격한 CI event-file 어댑터가 하나의 범위가 한정된 debounce queue에 입력을 제공합니다. 경로는 권한 없는 힌트로 남으며, 모든 전달은 동일한 전체 새로 고침 스캔을 호출합니다. 수락된 이벤트는 정식으로 정렬되고, 중복 및 제외/오버플로 관찰은 집계되며, `.lode` 이벤트는 자체 트리거를 일으키지 않습니다. 프로젝트 범위의 배타적 writer lease는 기존 포인터 비교 전에 수동, 파일시스템 및 CI 새로 고침을 직렬화합니다. 트리거 아티팩트에는 지시, 승격 또는 Canon 변경 권한이 없습니다. [`refresh-trigger.md`](refresh-trigger.md)를 참조하세요.

`GraphProjectionAdapter`는 별도의 그래프 구체화 및 순회 경계입니다. 내장 temporal GraphSnapshot은 복구 가능한 소스로 유지됩니다. 로컬 JSON, 메모리 내 및 명시적으로 활성화된 ArcadeDB 어댑터는 동일한 GraphSnapshot 및 TraversalResult ID를 보존하고, 권한 상승과 오래되거나 변조된 프로젝션을 거부하며, 구체화가 없을 때 내장 그래프 fallback을 공개합니다. `PreparedTraversalRequest`는 이미 확정된 쿼리와 결과를 정확하고 범위가 한정된 확장 증거에 바인딩합니다. ArcadeDB는 쿼리 시점에 전체를 다시 로드하지 않고 포인터와 topology manifest에서 해당 반경을 검증할 수 있습니다. topology manifest 및 범위가 한정된 순회 읽기는 독립적인 포인터 검사 후 쿼리 전용의 정확한 자식 배치 하나를 공유합니다. JavaScript bridge는 참조 전송 계층입니다. 네이티브 배포판에 무결성이 검증된 Go bridge가 있으면 이를 선택하지만, 모든 의미 및 권한 검증은 JavaScript에 남습니다. ArcadeDB vertex, edge, 전송 출력 및 영수증은 파생 증거로 유지되며 고유한 권한을 소유할 수 없습니다. [`graph-projection-adapter.md`](graph-projection-adapter.md)를 참조하세요.

준비된 순회의 성능 증거는 두 plane을 분리된 상태로 유지합니다. 정식 UTF-8 payload component 크기는 재현 가능하고 콘텐츠에서 파생된 비용 증거를 구성합니다. 경과 시간, 캐시 상태, 전송 호출 및 정규화된 관찰 응답 크기는 운영 진단일 뿐입니다. 실제 benchmark는 이미 검증된 activation만 사용할 수 있고 변경 메서드를 노출하지 않으므로, GraphDB 측정은 포인터를 전진시키거나 스키마를 생성하거나 권한을 변경할 수 없습니다.

`DocumentProjectionAdapter`는 검증된 그래프 이후의 별도 사람용 뷰 경계입니다. 결정론적 Markdown 참조 renderer는 콘텐츠에서 파생된 `DocumentProjection` 아티팩트와 `.lode/generated/knowledge` 아래의 교체 가능한 게시 뷰를 내보냅니다. 로컬 및 메모리 내 어댑터는 동일한 문서 콘텐츠와 프로젝션 ID를 보존해야 합니다. 명시적 생성은 계속 사용할 수 있습니다. 별도의 safe-default-manual `PostRefreshProjectionPolicy`는 검증된 새로 고침 이후 편집되지 않은 뷰에 대해서만 자동 게시를 활성화할 수 있으며, 불변 영수증은 policy, refresh, graph, projection 및 candidate 증거를 바인딩합니다. 게시된 드리프트는 절대 덮어쓰지 않습니다. 현재 편집 내용은 Canon, 지시 또는 승격 권한이 없는 불변 `DocumentChangeCandidateSet`이 됩니다. 범위가 지정된 명시적 검토는 사용자가 제공한 완전한 Product Model이 있을 때만 후보를 수락하고, 검증된 자식 GraphSnapshot을 재구축하여 Markdown을 조정할 수 있으며, 또는 Canon을 변경하지 않고 후보를 거부할 수 있습니다. 후보 집합, 검토, Product Model revisions 및 적용 영수증은 권한을 획득하지 않은 채 이후 감사 GraphSnapshots에 프로젝션됩니다. Obsidian과 Notion은 계속 연기됩니다. [`document-projection-adapter.md`](document-projection-adapter.md), [`document-change-review.md`](document-change-review.md) 및 [`post-refresh-projection.md`](post-refresh-projection.md)를 참조하세요.

semantic graph는 콘텐츠에서 파생된 node 및 edge ID, 파일 다이제스트 및 line 증거, 명시적인 source/confidence label과 `evidence-not-instruction` 신뢰 경계를 사용합니다. 기본 경로는 휴리스틱 file containment, module import와 해석 가능한 JavaScript/TypeScript/Python call입니다. 선택적 AST relation은 엄격한 current-manifest adapter contract를 통해서만 추가되며 의미·지시·승격·검토·복구 권한이 없는 P4 structural evidence입니다.

`.lode/context/product-model.json`의 Product Model 소스는 사용자가 소유하는 Canon입니다. 저장소 디렉터리와 독립적으로 안정적인 FeatureGroup, Capability, Feature, Requirement, Constraint 및 Decision 키를 정의합니다. 선택적 schema-v2 Policy record는 불변 P3 candidate와 정확한 user ReviewDecision을 거쳐 명시적인 Feature 또는 FeatureGroup key에만 적용됩니다. Group membership은 inheritance를 만들지 않으며 graph는 두 번째 Policy store가 아닙니다. Schema-v1 byte와 identity는 정확히 유지됩니다. 이전에 초기화된 프로젝트에서 Product Model이 누락된 경우 이는 명시적으로 비어 있는 semantic model입니다. 코드와 문서가 자동으로 채우지 않습니다. [`product-model.md`](product-model.md)를 참조하세요.

temporal provenance graph는 별도의 검증된 프로젝션입니다. traversal protocol은 `lexical-discovery`와 exact Lode anchor mode를 상호 배타적으로 제공합니다. exact mode는 현재 GraphSnapshot과 1~32개의 node ID에 결속되고 relation·authority·freshness·confidence·depth·node·edge·candidate policy를 확대할 수 없습니다. Context Compiler는 Lode 소유 EvidenceNeed 안의 exact anchor만 받아 별도 `GraphTraversalEvidence`를 만들며 lexical search를 semantic relevance로 승격하지 않습니다. Product relation은 `canon-projected`이고 candidate-space node는 명시적 opt-in 없이 숨겨지며, local/ArcadeDB projection은 embedded GraphSnapshot을 복구 소스로 보존합니다. Policy approval path는 무관한 Product Model revision 뒤에도 변경되지 않은 current Policy revision과 연결됩니다. review된 source change와 product impact는 exact revision에 결속되며 Git ref만으로 deployment를 추론하지 않습니다.

Graph 계보는 두 번째 이력 저장소를 만들지 않고 보존된 content-addressed World snapshot을 재사용합니다. `GraphLineageStatusProjection`, `GraphLineageTraceProjection`, `GraphLineageDiffProjection`은 bounded Hot/Warm/Cold page, exact 또는 discovery trace, 검증된 execution artifact reference, Policy-evidence byte currentness, snapshot diff를 제공하는 비지속 P4 view입니다. 이들은 P2 recovery direction을 쓰거나 accepted Policy를 무효화하거나 semantic continuity를 추론할 수 없습니다. 제거·추가된 path 사이의 동일 content digest는 `exact-content-possible-move` evidence만 만들며, semantic identity 주장은 별도 Lode proposal이고 실제 승격할 때만 review가 필요합니다.

공급자 중립 공통 Observation 경계는 Core에 제품 어휘를 가르치지 않고 domain-shaped data를 기록합니다. `ObservationTypeDescriptor`, `ObservationRecord`, `DerivedObservationRecord`, `ObservationCollectionReceipt`는 P3이고, `ObservationStatusProjection`은 별도의 재구축 가능한 P4 evidence graph이며 검증된 node와 relation은 unified temporal GraphSnapshot에도 projection됩니다. `ObservationSourceBinding`은 P5 Host configuration입니다. process-local `ObservationAdapterRegistry`는 source별 optional adapter를 하나의 정확한 ready Project에 binding하면서 path, credential, cursor 또는 provider identity를 persist하지 않습니다. 비지속 discovery view는 registration gate 없이 exact filter, disclosed read-only resynchronization을 포함한 opaque pagination, bounded descriptor shape, Host-local availability hint를 제공합니다. `ObservationPreparationProjection`은 reuse-first UX를 위해 exact existing-evidence query와 matching source discovery를 결합하지만 meaning, sufficiency, source 또는 collection을 선택하지 않습니다. Host-injected MCP composition은 opaque Project-bound source ID로만 collect합니다. `JsonEventFileObservationAdapter`는 MCP file-path surface를 추가하지 않는 bounded one-shot CI reference를 제공합니다. 자동 graph relation은 `CONFORMS_TO`, `EVIDENCED_BY`, `DERIVED_FROM`으로 제한됩니다. Metric workflow는 같은 P3 record를 재사용하고, numeric comparison을 막지 않으면서 adapter-revision 및 다른 collection condition difference를 보여주며, assessment는 non-causal ProductHypothesis와 선택적인 review-gated initiative candidate로 유지합니다. Context Compiler는 정확한 Lode 소유 EvidenceNeed를 통해서만 observation을 포함합니다. observation collection은 Product Canon, product meaning, ReviewDecision 또는 P2 recovery direction을 만들 수 없습니다. 잘못된 Observation lineage는 해당 graph layer만 unavailable로 만들며 관련 없는 World/Product 작업은 계속 사용할 수 있습니다. [`observation-adapters.md`](observation-adapters.md)를 참고하세요.

비차단 Conformance 재정은 공급자 Lode가 정확히 승인된 Canon을 현재 source, ChangeSet, Observation 또는 선택적 Graph evidence와 비교하게 합니다. Core는 anchor를 검증하고 P3 candidate, resolution candidate, exact-Finding 사용자 disposition만 지속하며 lexical 또는 semantic verdict를 수행하지 않습니다. paginated P4 queue와 candidate-hidden audit graph는 일반 작업을 막거나 fix를 승인하거나 Canon을 개정하거나 recovery를 쓸 수 없습니다. Graph 부재, partial coverage, 선택적 adapter 손실, advisory risk는 disclosure로 남습니다. process-local 선택적 P5 trigger registry는 검증된 Host evidence를 coalesce하고 uncertain provider outcome 뒤 automatic replay를 중단합니다. 기본 opportunistic 사용은 background provider를 호출하지 않습니다. [`conformance-reconciliation.md`](conformance-reconciliation.md)를 참고하세요.

`DeploymentResultAdapter`는 별도의 Host observation 경계입니다. Provider run/session/process identity를 저장하지 않고 bounded deployment fact와 evidence digest를 제공합니다. Core는 create-only `BranchStateObservation`, `DeploymentResultObservation`, 조건을 충족한 `ReleaseObservation` P3 evidence를 기록하기 전에 reachable Git history와 현재 product ref를 독립적으로 검증합니다. 해당 P4 graph projection은 배포를 허가하거나, 제품 outcome을 승인하거나, Product Canon을 변경하거나, P2 복구 방향을 쓸 수 없습니다. [`release-observation.md`](release-observation.md)를 참고하세요.

## Native compute plane

`ComputeAdapter` 계약 `0.3.0`과 WorkerProtocol `0.2.0`은 semantic ID를 변경하거나 JavaScript 제어 영역에서 권한을 이전하지 않는 교체 가능한 연산 경계를 정의합니다. 정식 요청은 버전이 지정된 작업, 입력 다이제스트, semantic producer 및 리소스 제한을 바인딩합니다. 정식 응답은 전부 성공하거나 전부 실패하며, 다이제스트가 검증되고, 크기가 제한되고, 구조화되며, `authorityEffect: none`으로 고정됩니다.

`JsReferenceComputeAdapter`는 적합성 기준과 로컬 fallback으로 유지됩니다. `GoWorkerComputeAdapter`는 콘텐츠 주소 지정 platform manifest를 검증하고, 실행 파일을 플러그인 배포 루트로 한정하며, shell 없이 직접 실행하고, stdio와 시간을 제한하며, 정확한 자식 PID 종료를 검증합니다. 누락, 비호환, 손상, 미지원, spawn 실패 또는 crash된 네이티브 경로는 공개된 운영 사유 코드와 함께 JavaScript로 fallback합니다. 유효하지 않은 네이티브 응답, timeout 및 취소 실패는 fail-closed 방식으로 실패합니다. 이제 Go `repository.scan.v1` 후보는 다국어 및 Unicode 증거와 명시적 include/exclude source scope를 포함해 일곱 개의 완전한 성공/실패 응답 및 동일한 corpus ID와 일치합니다. 비교 benchmark 결과 소규모 및 중간 입력에서는 성능이 저하되고 대규모 입력에서는 근소하게 개선될 뿐이므로, release manifest는 여전히 `worker.health.v1`만 알립니다. 프로덕션 World Model scan은 JavaScript에 남습니다. compute 기반 graph 작업과 benchmark로 정당화된 네이티브 선택 정책은 계속 연기됩니다. [`compute-adapter.md`](compute-adapter.md)를 참조하세요.

`GitHistoryAdapter`는 재구축 가능하고 콘텐츠 주소가 지정된 commit 증거를 별도로 제공합니다. 기본 비동기 Git CLI 어댑터는 프로세스를 실행할 수 없을 때 명시적인 coverage 정보와 함께 fail-open할 수 있습니다. byte-preserving host-export 어댑터는 제한된 런타임에서 동일한 semantic input을 제공합니다. 현재 refs는 도달 가능성을 검증하며, commit message는 지시나 승격된 결정이 아니라 증거로 남습니다.

`RuntimeStateAdapter`는 엄격한 특정 시점의 외부 런타임 관찰을 제공합니다. source descriptor는 semantic ID가 아니라 pointer metadata이며, 정규화된 관찰은 콘텐츠 주소가 지정되고 최신성 게이트를 거칩니다. 어댑터는 읽기 전용이며 지시 권한이나 런타임 제어 권한을 부여하지 않습니다. 별도의 `PlatformAdapter`, `AgentRuntimeAdapter` 및 `WorkspaceHostAdapter` 참조가 공급자/플랫폼/호스트 구성을 명시적으로 만듭니다. 현재 호스트 탐색, 범위가 한정된 고정 버전/help 증거 및 `RuntimeProjectBinding`은 권한 부여 없이 capability를 확립합니다. 그 다음 호출 권한 부여 계층은 정확한 활성 Lode 리니지에서 실행 기능이 없는 단일 호출 경계를 도출합니다. 영속적인 at-most-once lease는 supervisor 시작 전에 이를 소비하고, 완료, timeout, 취소 또는 호출자 실패 후에도 재실행할 수 없게 유지합니다. event/receipt/draft 스키마, 네이티브 Job Object/process-group 픽스처 및 실제 Codex/OpenCode Session/Run 증거는 제어 영역과 프로세스 트리 정리 형태를 입증합니다. 선택적 exact-endpoint attachment는 비권위적 Host 기능이며 일반 task는 Host-native coordination을 사용합니다. P2-first 방식의 정확한 선택적 연결 및 소유권이 정확한 일회성 interrupt/close가 활성화됩니다. 공급자 hydration, 일반 resume/stream 및 더 광범위한 프로세스 제어는 계속 연기됩니다. AST 수준으로 정확한 그래프와 구조화된 Git 결정 추론도 계속 연기됩니다. [`runtime-state.md`](runtime-state.md)와 [`runtime-adapters.md`](runtime-adapters.md)를 참조하세요.

<a id="detailed-core-model"></a>

## 핵심 모델

Lode는 의미, 복구, 증거, 뷰, 효과를 분리하여 하나의 표현이 다른 표현의
권한을 상속하지 못하게 합니다.

| 평면 | 소유 대상 | 예시 | 부여하지 않는 권한 |
| --- | --- | --- | --- |
| P1 규범적 권한 | 승인된 의미와 명시적 결정 | Product Canon, ReviewDecision | 그래프·결과·메시지에서 승인을 추론하는 권한 |
| P2 복구와 계보 | 공급자와 독립적인 프로젝트 방향 | Session, Run, 계획, Capsule, 계약, 체크포인트 | 요약이나 결과로 방향을 다시 쓰는 권한 |
| P3 증거 | 검토 가능한 관찰과 결과 | 후보, ResultPacket, ChangeSet, 영수증 | 자기 승격이나 체크포인트 작성 권한 |
| P4 파생 뷰 | 재현 가능한 검색 및 사람용 뷰 | GraphSnapshot, 탐색 결과, Markdown, 연속성 뷰 | Canon 변경이나 유일한 복구 원천이 될 권한 |
| P5 운영 효과 | 호스트 로컬 실행과 전달 | PID, 임대, 엔드포인트, 받은 편지함, 전달 영수증 | 실행·검토·승격·복구 권한 |

배포와 호스트 통합은 이 계약을 패키징하거나 실행할 뿐, 제품 의미의 여섯
번째 원천이 되지 않습니다. 전체 실행 가능 경계는
[권한 평면 문서](authority-plane-contract.md)에 설명되어 있습니다.

기본 원칙과 Record/Graph의 공식 경계는
[공급자 중립 Lode 헌법](lode-constitution.md)에 설명되어 있습니다.

### 아키텍처 개요

```mermaid
flowchart LR
    U[User objective] --> H[Whole-plan Lode]
    PC[Product Canon] --> WM[World Model + GraphSnapshot]
    RE[Repository evidence] --> WM
    H --> CC[Context Compiler]
    WM -->|bounded evidence| CC
    CC --> RA[Runtime adapter]
    RA --> RP[ResultPacket]
    RP --> FR[Fresh Lode review]
    WM --> PX[Local / ArcadeDB / Markdown projections]
```

피드백 경로도 명시적입니다. 승인된 결과는 검토된 계보가 될 수 있고,
저장소를 다시 인덱싱할 수 있으며, 이후 그래프가 그 증거를 투영할 수
있습니다. 결과, 프로젝션 또는 런타임 효과가 스스로를 승인할 수는 없습니다.

### Lode가 의미를 판단하고 Compiler가 선택 맥락을 제공하는 컨텍스트

Context Compiler는 명시적인 예산 안에서 작업용으로 선택한 증거를 묶습니다.
포함·제외·오래됨·누락·잘림·미확인 항목을 기록합니다. 동일한 정본 입력,
컴파일러 버전, 탐색 정책, 예산은 동일한 Context Capsule을 재현합니다.

예산의 기본값은 약 `32768` 토큰이며 Lode가 양의 안전한 정수를 선택할 수 있습니다.
고정된 다섯 계층이나 512K 정책 상한은 없습니다. 실제 공급자의 컨텍스트 크기와
출력 예약분은 계속 적용되며, 근사치가 토크나이저 기준의 적합성을 증명하지는 않습니다.

Lode는 정확한 저장소 경로, Product Canon 키, Observation ID나 범위가 정해진
현재 그래프의 기준 노드로 자료 선택을 안내할 수 있습니다. Compiler는 포함을
인증하는 대신 `evidenceGaps`, `omissions`, `uncertainty`를 제공합니다. 추가 소스가
필요한지는 Lode가 판단합니다. 저장된 ExecutionContract는 그 판단을 기록하며
의미적 수용을 기계적으로 만들어 내지는 않습니다.

Capsule은 파생된 실행 입력이지 두 번째 Canon이 아닙니다. 다이제스트 또는
Canon 드리프트는 실패 폐쇄되며, 단순한 읽기·추론 작업은 기본적으로
Capsule을 만들지 않습니다.

### 실행과 복구

관리형 실행은 다음과 같이 기록과 검토가 남는 순서를 따릅니다.

```text
WholePlanSnapshot
  → ExecutionContract + ContextCapsule
  → runtime or bounded worker
  → ResultPacket
  → Fresh Lode ReviewDecision
  → accepted lineage or a revised plan
```

공급자 손실 시 대화 기록을 가져올 필요가 없습니다. `session-restore`는 정확한
P2 체크포인트와 검증된 계보에서 현재 입력을 재구성합니다. 결과가 승인된
뒤에도 `run-integrate-checkpoint`는 Lode 또는 사용자가 복구 필드를 명시적으로
제공한 경우에만 그 검토를 새 체크포인트와 연결할 수 있습니다.

신뢰하는 Host 어댑터가 있을 때 관리형 컨텍스트 압축은 다음 계약을 따릅니다.
패키지의 읽기 전용 맥락 전달만으로 이 전체 절차를 수행하지는 않습니다.

1. 공급자 측 Lode가 압축 전에 정확한 P2 방향을 작성하거나 재사용합니다.
2. 공급자 중립 Host 어댑터가 일회용 전달 토큰을 프로젝트 Canon 밖에 보관하고
   공급자 소유의 압축을 수행합니다.
3. Core는 P2를 먼저 복원한 뒤 신뢰할 수 있는 실제 사용자 턴 근거를 검사합니다.
   기준 변경, 불확실한 재실행과 요약 기반 복구는 거부합니다.
4. Host가 체크포인트에 결속된 작업 재개 요청을 최대 한 번 제출하거나, Lode가
   검증된 기록에서 새로운 논리적 Lode로 계속함을 명시합니다.

일반 사용자는 작업을 계속 말하면 됩니다. Skill은 읽기 전용
`lode_conversation_enter`로 자동 진입하고, `compact-*`와
`lode_compaction_lifecycle_step`은 고급 어댑터와 진단 작업에 사용합니다.
Host Hook이 없어도 추가 설정을 요구하거나 일반 작업을 막지 않습니다.

방향을 지속 가능한 기록으로 갱신할 때 Skill은 내부적으로 읽기 전용
`lode_checkpoint_basis`와 멱등적인 `lode_checkpoint_sync`를 사용합니다. Core는
`created`, `reused`, `deferred`, `conflict` 중 하나를 반환하며, 필요한 경우 해당 복구
경로만 멈춥니다. 어느 결과도 사용자에게 체크포인트 JSON을 요구하지 않습니다.

복구 상태를 설명해야 할 때 `lode_checkpoint_diagnose`는 현재 포인터, 기록 복원
결과, 기계적 갱신 가능 여부와 다음 Lode 동작을 범위가 제한된 읽기 전용 응답으로
보여줍니다. 잠금이나 캐시를 쓰지 않고, 상태를 읽기 위해 다른 모델을 호출하지도
않습니다. ID와 해시 일치는 기록의 정합성을 증명하며 체크포인트 문장이 최신
사용자 의도를 반영한다는 뜻은 아닙니다. 순차 읽기 중 상태가 바뀌면 다시 읽어야
합니다. 원자적 파일시스템 스냅샷이나 ABA 감지는 보장하지 않습니다. 실제 복구
결함이 있어도 체크포인트 의존 작업만 멈추고 독립 작업은 계속할 수 있습니다.

사용자의 새 요청은 대기 중인 작업 재개보다 우선합니다. 자세한 내용은
[컨텍스트 압축 복구](compaction-recovery.md)와
[Session 복구](session-recovery.md)를 참고하세요.

### 제품 학습

일상적인 관찰은 지속하지 않는 메모로 남길 수 있습니다. 다른 Run, 감사,
제품 상태 전이 또는 인수인계에서 필요한 경우에만 영구 아티팩트를 만듭니다.

```text
Signal → Hypothesis → Initiative candidate → user ReviewDecision
       → reviewed Initiative → accepted execution → OutcomeObservation
```

이 흐름은 하나의 자동 승격 사슬이 아닙니다. 증거는 증거로, 가설은 가설로
남고, 검토된 Initiative도 Product Canon과 구분됩니다.
Lode가 추천 API나 메모 형식화 호출 없이 위험과 필요한 지속성을 직접 판단합니다.

- Observe: 읽기와 추론 작업
- Session: 하나의 범위가 제한된 가역적 결과
- Run: 서로 의존하거나 복구 민감한 작업
- 명시적 권한: Canon·Initiative 결정 또는 현재 승인 범위 밖의 효과 실행.
  기존 승인 방향 안에서 유용한 checkpoint를 갱신하는 것은 새 사용자 결정이 아닙니다.

자세한 내용은 [Product Operating Loop](product-operating-loop.md)를
참고하세요.
Git ref와 배포 근거 수집은 [Release observation](release-observation.md)에,
환경별·대상별 적용, 실패와 롤백 이력은
[전달 상태 관측](delivery-observation.md)에 설명되어 있습니다.

<a id="runtime-coordination-reference"></a>

## 런타임과 역할 통신

Claude Code, Codex, OpenCode는 하나의 `.lode/` 권한을 공유하는 프로젝션입니다. 런타임
어댑터는 기능을 관찰하고, 정확한 권한을 최대 한 번 소비하며, 소유한 프로세스
트리를 감독하고, 구조화된 출력을 검증하고, 운영 상태를 프로젝트 밖에
보관합니다.

일반 위임은 현재 Host의 작업, 메시지와 진행 상태를 사용합니다. Lode가 맥락과
소유 범위를 전달하고 완료된 기여를 통합합니다. 효과가 불명확한 작업은 확인한 뒤
미완료 부분만 처리합니다. 별도의 Lode 역할 토큰, 세대, 받은 편지함이나 대상 경로를
설정하지 않습니다. 워커가 성공해도 Canon 승인이나 복구 방향 작성 권한은 생기지 않습니다.

선택적인 엔드포인트 연결은 P2 방향을 먼저 복구하고, 정확한 live endpoint를 검증할
수 있을 때만 연결합니다. endpoint가 사라졌다면 검증된 기록을 바탕으로 새로운
논리 Lode로 이어감을 명시합니다. 이식 가능한 export 브리지는 연결 전용이며 현재 스냅샷 하나만
보존합니다. 지속적인 메시지 전달 서비스는 아닙니다. Host별 pane/socket/UI 동작은
Core 밖에 둡니다. [런타임 어댑터](runtime-adapters.md)와
[Host 위임과 연결](role-coordination.md)을 참고하세요.

<a id="optional-graphdb-reference"></a>

## 선택적 GraphDB

기본 저장소는 로컬입니다. 온보딩, 컨텍스트 컴파일, 실행 계보 또는
복구에 GraphDB가 필요하지 않습니다.

ArcadeDB는 파생 그래프 프로젝션으로 명시적으로 활성화할 수 있습니다. 자격
증명은 환경 변수 참조를 통해서만 해석되며 프로젝트 아티팩트, 그래프 식별자,
생성 문서 또는 영수증에 들어가지 않습니다. 원격 활성화는 복구 가능한 내장
그래프와 의미적으로 동일함을 증명해야 합니다.

JavaScript 브리지가 의미적 기준 구현입니다. 검증된 네이티브 패키지가 있으면
읽기 전용 준비 질의가 콘텐츠 주소 기반 Go query-batch 브리지를 사용할 수
있습니다. 이 경우에도 JavaScript가 포인터, 토폴로지, 탐색 결과, 요청 연결,
영수증을 검증합니다. `LODE_AGENT_ARCADEDB_NATIVE_MODE`는 다음 중 하나로
설정합니다.

- `auto`: 검증된 네이티브 브리지가 있으면 사용하고, 없으면 이를 알린 뒤
  JavaScript 기준 경로를 사용합니다.
- `off`: 항상 JavaScript 경로를 사용합니다.
- `required`: 검증된 네이티브 경로를 사용할 수 없으면 실패합니다.

매니페스트, 바이너리, 선택 후 다이제스트가 일치하지 않으면 항상 실패
폐쇄됩니다. 정확한 자식 프로세스에는 설정된 자격 증명 참조 변수와 제한된
OS, TLS, 로캘, 프록시 허용 목록만 전달됩니다. 계산 워커 자체는 네트워크와
권한을 갖지 않습니다. 자세한 내용은
[그래프 프로젝션 어댑터](graph-projection-adapter.md)를 참고하세요.

<a id="design-principles-reference"></a>

## 설계 원칙

Lode Agent Core Plugin은
[Won6314/head-agent-core](https://github.com/Won6314/head-agent-core)에서
영감을 받아 공급자 중립적인 플러그인으로 독립 재구성한 프로젝트입니다.
공식 업스트림 릴리스나 드롭인 대체재가 아닙니다. 자세한 내용은
[소스 기반 비교 문서](original-head-core-comparison.md)를 참고하세요.

이 구현은 Lode의 기반 원칙을 유지하면서 공급자 중립적인 계약으로
표현합니다.

- Lode는 연결된 전체 결과를 소유합니다.
- 사용자는 중요한 결정 권한을 유지합니다.
- 의미적 충분성은 Lode가 판단하며, 최대 컨텍스트보다 범위가 정해지고 검증된 맥락을 우선합니다.
- 지속 가능한 Canon은 임시 모델 세션보다 오래 유지됩니다.
- 위임은 범위가 제한되며 권한을 획득하지 않습니다.
- 완료 판단에는 연결된 1차 증거가 필요합니다.
- 그래프는 의심하지 않는 권위가 아니라 검색 인덱스입니다.
- 프로젝트 의미는 런타임 메커니즘과 분리됩니다.

원래 설계 맥락은 업스트림
[Foundations](https://github.com/Won6314/head-agent-core/blob/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa/packages/core/docs/FOUNDATIONS.md)와
[Technical Architecture](https://github.com/Won6314/head-agent-core/blob/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa/packages/core/docs/TECHNICAL_ARCHITECTURE.md)를
참고하세요.

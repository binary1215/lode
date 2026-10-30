# Lode Agent Core 한국어 문서

[English documentation](../README.md)

이 색인은 플러그인과 함께 배포되는 공개 문서의 한국어판을 안내합니다.
과거 설계 기록은 각 문서 안에서 별도로 표시합니다. 개발 전용 작업 기록은
배포 대상이 아니며 런타임 권한도 갖지 않습니다.

## 먼저 읽을 문서

| 하려는 일 | 먼저 볼 곳 |
| --- | --- |
| 내 클라이언트에 설치 | [설치](../../README.ko.md#설치) |
| 실제 작업 시작 | [첫 요청](../../README.ko.md#first-request) |
| 남은 작업에서 재개 | [복구](../../README.ko.md#recovery), [저장된 작업](session-work-context.md) |
| 이유와 변경 전후 확인 | [기록된 맥락과 diff](context-lineage.md) |
| 작업 흐름 자동화 | [Core 명령](#command-reference), [Context 예제](context-compiler.md#context-examples), [선택적 Product 설정](onboarding.md#product-cli-examples) |

## 아키텍처와 Product 참조

- [아키텍처 결정](architecture.md)
- [공급자 중립 Lode 헌법](lode-constitution.md)
- [권한 평면과 Graph/기록 경계](authority-plane-contract.md)
- [프로젝트 온보딩](onboarding.md)
- [독립 실행 legacy 온보딩 migrator 경계](onboarding-migrator.md)
- [Product Model 정본](product-model.md)
- [Product Operating Loop](product-operating-loop.md)
- [Release observation](release-observation.md)
- [전달 상태 관측](delivery-observation.md)

## 컨텍스트, 월드 모델, 검색

- [그래프 우선 탐색과 독립 Session](graph-discovery.md)
- [로컬 읽기 전용 Graph Explorer](graph-explorer.md)
- [기록된 코드 맥락과 전후 비교](context-lineage.md)
- [Lode Context Compiler 설계](context-compiler.md)
- [저장소 World Model 의미론](world-model.md)
- [스냅샷 인코딩·저장 진단과 보존](snapshot-storage.md)
- [시간 출처 GraphSnapshot](temporal-provenance.md)
- [검토 게이트 Feature 매핑](feature-mapping.md)
- [관찰 상태 증분 갱신](incremental-refresh.md)
- [디바운스 갱신 트리거](refresh-trigger.md)
- [갱신 후 Markdown 프로젝션 정책](post-refresh-projection.md)

## 실행, 복구, 역할 조정

- [복구 의미·Session 선택·World 도메인](recovery-state-separation.md)
- [작업 산출물 저장 가이드](artifact-storage.md)
- [Execution Lineage 계약과 Run 수명주기](execution-lineage.md)
- [공급자 중립 ChangeSet과 검토된 영향](change-sets.md)
- [비차단 Conformance 재정](conformance-reconciliation.md)
- [대화 압축 복구](compaction-recovery.md)
- [Session 복원과 검토 결과 통합](session-recovery.md)
- [Session 작업 맥락과 Host 연속성](session-work-context.md)
- [일반 Host 위임과 선택적 연결](role-coordination.md)
- [공급자 중립 bounded worker launch wave](bounded-worker-wave.md)
- [Worker 컨텍스트와 Lode 통합](worker-context-integration.md)
- [선택적 provider-neutral Worker Admission](worker-admission.md)
- [외부 런타임 상태 증거](runtime-state.md)

## 어댑터와 프로젝션

- [런타임 어댑터 계약](runtime-adapters.md)
- [공통 Observation 계약과 어댑터](observation-adapters.md)
- [ComputeAdapter와 WorkerProtocol 기준](compute-adapter.md)
- [GraphProjectionAdapter 계약](graph-projection-adapter.md)
- [DocumentProjectionAdapter와 결정적 Markdown 프로젝션](document-projection-adapter.md)
- [문서 변경 검토와 적용](document-change-review.md)
- [철학을 보존하는 fast path](performance-fast-path-design.md)

## 배포와 검증

- [검증 증거와 한계](verification-evidence.md)

- [Codex 마켓플레이스 배포](codex-marketplace.md)
- [Claude Code 마켓플레이스 배포](claude-marketplace.md)
- [규칙 표면 감사](rule-surface-audit.md)

## 과거 설계 증거

다음 문서는 이전 설계 비교나 감사를 설명합니다. 위의 현재 실행 가능 계약보다
우선하지 않습니다.

- [원본 HEAD Core 비교](original-head-core-comparison.md)
- [Lode-Agent GraphDB Brief v4 요약 및 설계 검토](Lode_GraphDB_Brief_v4.md)

<a id="command-reference"></a>

## CLI, 자동화와 고급 설정

일반 사용자는 [README의 첫 요청](../../README.ko.md#first-request)처럼 자기 작업을 말하면 됩니다. CLI는 스크립트, CI, 오프라인 복구나
Host 연동에서 안내 대화 없이 같은 결정론적 Core 동작을 실행할 때 사용합니다.

기본 경로는 공급자 중립 Lode 헌법과 고정 Project/Session 복구 앵커만
초기화합니다.

```powershell
lode-agent init C:\path\to\project --runtime claude,codex,opencode
```

이 경로는 ID를 보존하고 가능한 기존 관측 자료의 경량 색인을 갱신하면서
`core_ready`를 반환합니다. 제품 의미 추론, 관리 World 구성과 문서 거버넌스는
선택 사항으로 남습니다. 같은 범위 제한 상태는 언제든 확인할
수 있습니다.

```powershell
lode-agent status C:\path\to\project
```

정상 상태는 한 줄로 보여줍니다. 예외가 있으면 담당 주체, 이유, 영향을 받는
작업과 다음 행동을 표시합니다. `doctor` 또는 `--json`에서는 Core, 선택적 Product
관리, Context 준비도, 실행 중인 CLI·라이브러리와 구성된 패키지의 버전, 기술
세부 정보를 확인할 수 있습니다. 이 패키지 조회만으로 Host 도구 로딩을 확인하지는
않습니다. 구조화된 결과는 `readiness.core`, `readiness.product`,
`readiness.context`를 나누어 보여주고, 지금 수행할 `nextAction` 하나와 선택 기능의
실제 선행조건을 표시합니다. Product는 `available-not-activated`, 관리형 bounded
worker는 `requires-session-or-run-authorization`으로 표시됩니다. 일반 독립 검토는
현재 Host의 위임을 쓰며, 워커 수만으로 Run을 요구하지 않습니다. 이 조회 결과는
저장하지 않으며 Product 활성화, Run 생성, 권한 부여나 드리프트 복구를 일으키지
않습니다. `profile`은 한 번의 초기화·재개 범위를 선택하는 값이며 숨은 프로젝트
모드가 아닙니다.

최상위 상태는 `core_ready`, `product_evidence_required`, `product_review_required`,
`product_ready`, `product_refresh_required`, `core_drifted` 중 하나입니다. 세부 온보딩
상태는 `readiness.product.onboardingStatus`에 남습니다.

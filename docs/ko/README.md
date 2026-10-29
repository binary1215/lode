# Lode Agent Core 한국어 문서

[English documentation](../README.md)

이 색인은 플러그인과 함께 배포되는 공개 문서의 한국어판을 안내합니다.
과거 설계 기록은 각 문서 안에서 별도로 표시합니다. 개발 전용 작업 기록은
배포 대상이 아니며 런타임 권한도 갖지 않습니다.

## 먼저 읽을 문서

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

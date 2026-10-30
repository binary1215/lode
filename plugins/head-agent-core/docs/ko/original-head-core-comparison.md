[영어 원문](../original-head-core-comparison.md)

# Original HEAD Core 비교

검토일: 2026-08-20

상태: 과거 소스 비교. 이후의 Claude Code 지원, 헌법 프로필 기본값, 제한된 worker wave, 준비 상태 UX 및 출처 연결 선택 맥락 준비은 검토된 소스 범위에 포함되지 않으며, 이 문서에서 추론하지 말고 현재 아키텍처와 실행 가능한 테스트를 바탕으로 평가해야 합니다.

이 문서는 추출한 `Won6314/head-agent-core` 참조 구현과 이 제공자 중립적 플러그인을 비교합니다. 설계 계보, 채택한 수정 사항, 그리고 이 플러그인이 범용 플러그인 사용에 더 적합하다는 주장이 여전히 지니는 한계를 기록합니다. 이 문서는 공식 업스트림 릴리스, 즉시 교체 가능한 대체물 또는 모든 업스트림 호스트 기능의 상위 집합이라고 주장하지 않습니다.

## 참조 기준

과거 비교는 추출한 원본 Core의 다음 경로를 참조합니다.

- 전체 결과의 소유권과 의사결정 권한은 `packages/core/head/HEAD_CORE.md`를 참조합니다.
- 제한된 컨텍스트, Canon, 위임, 증거 및 Core/프로젝트 경계는 `packages/core/docs/FOUNDATIONS.md`를 참조합니다.
- 설치된 OpenCode, Herdr, Session/Run, worker 및 역할 메시지 아키텍처는 `packages/core/docs/TECHNICAL_ARCHITECTURE.md`를 참조합니다.
- 비례적 장치와 생성 규칙은 `packages/core/theory/04-evolution-evidence-and-limits.md` 및 일반 규칙 과정을 참조합니다.

2026-08-20에 사용한 정확한 업스트림 커밋은 여기에 기록되어 있지 않습니다.
위 경로 문자열은 역사적 참조이며, 다음 확인 결과로 당시의 미확인 기준을
복원하거나 대체하지 않습니다.

2026-10-20에 업스트림
[`ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa`](https://github.com/Won6314/head-agent-core/tree/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa)의
소스 경로를 다시 확인했습니다.
[HEAD Core](https://github.com/Won6314/head-agent-core/blob/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa/packages/core/head/HEAD_CORE.md),
[Foundations](https://github.com/Won6314/head-agent-core/blob/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa/packages/core/docs/FOUNDATIONS.md),
[Technical Architecture](https://github.com/Won6314/head-agent-core/blob/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa/packages/core/docs/TECHNICAL_ARCHITECTURE.md),
[Evolution, evidence and limits](https://github.com/Won6314/head-agent-core/blob/ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa/packages/core/theory/04-evolution-evidence-and-limits.md)의
영구 링크입니다. 별도로 확인한 plugin-root 커밋
[`067701f0c0390a6b9f7dfd1a90a417d10247bd02`](https://github.com/Won6314/head-agent-core/tree/067701f0c0390a6b9f7dfd1a90a417d10247bd02)에는
`instructions/HEAD_CORE.md`가 있지만 과거의
`packages/core/docs/FOUNDATIONS.md` 경로는 없습니다. 이 링크는 2026-10-20의
확인 기준이며, 새로운 비교 판정이나 이전 감사의 출처를 뜻하지 않습니다.

이 참조 구현은 이 플러그인이 반드시 유지해야 하는 여섯 가지 이식 가능한 원칙을 확립합니다.

1. 전체 결과는 HEAD가 소유하고, 중대한 방향은 사용자가 소유합니다.
2. 서로 연결된 하나의 주 흐름은 연결되지 않은 형식적 절차보다 더 강한 증거입니다.
3. 컨텍스트는 하나의 소유자와 결과를 위한 가장 작은 완전한 권위 있는 집합입니다.
4. Session/Run Canon은 정보가 손실되는 대화와 생성된 요약 이후에도 존속합니다.
5. worker 결과는 증거이며 자동으로 권한이 되지 않습니다.
6. 구조는 결과의 중대성, 조정, 연속성 및 증거에 비례해 확장됩니다.

## 구조 비교

| 관심사 | Original HEAD Core | 이 플러그인 | 범용 플러그인 관점의 결과 |
| --- | --- | --- | --- |
| 런타임 구성 | 하나의 루프백 조정 데몬과 정확한 pane/tab/session 증거를 갖춘 사용자 범위 OpenCode/Herdr 설치 | 타입이 지정된 Claude Code, Codex, OpenCode 어댑터, 이식 가능한 CLI/MCP 표면, 런타임 독립적인 HEAD ID, 주입된 정확한 엔드포인트 WorkspaceHost 계약 및 프로덕션 host-export 파일시스템 브리지를 갖춘 하나의 제공자 중립적 Core | 제공자를 교체해도 프로젝트 의미는 교체되지 않습니다. 이 플러그인은 호스트별 실행 파일, 소켓, 명령, pane 또는 TUI 지식을 내장하지 않으면서 엔드포인트 ID와 외부 호스트 전달을 일반화합니다. 한편 원본에는 확립된 installed-Herdr 제공자 클라이언트 운영 경로가 여전히 있습니다. |
| 지속 권한 | 프로젝트 소유 Session/Run Canon과 호스트 소유 task/message 상태 | Git에 독립적인 Project, Session, Run, Product Canon, World Model, Context, Execution Lineage 및 복구 아티팩트 | 더 많은 의미 및 실행 상태를 제공자와 스토리지 백엔드 사이에서 이식할 수 있습니다. |
| 그래프 역할 | 연결된 소스 파일이 계속 권위 있는 상태로 남는 검색 인덱스 | 로컬, GraphDB 및 문서 프로젝션이 계속 재구축 가능하고 비권위적으로 유지되는 내장 콘텐츠 주소 지정 GraphSnapshot | 그래프 스토리지는 선택 사항이며 숨겨진 오케스트레이터나 진실의 원천이 될 수 없습니다. |
| 제품 모델 | 제품 및 정책 정의는 프로젝트 소유 확장으로 유지 | 엄격하게 사용자 소유인 Product Canon과 candidate/review 경계 및 Product Operating Loop | 추론이나 결과가 Canon을 승격시키지 못하도록 하면서 제품 학습을 통합합니다. |
| 일반 작업 | 직접적이고 일관된 작업이 기본이며, Run, worker, graph 및 공식 검토는 조건부 | Observe, Session, Run 및 Authority 레인이 가장 가벼우면서 안전한 계약을 선택하며, 추천 자체에는 권한이 없음 | 범용 사용이 읽기/추론 작업에 무거운 lineage를 강제하지 않습니다. |
| 연속성 | Canonical Session/Run 복구 및 명시적인 압축 후 연속 작업 최대 한 번 | Canonical Session/Run 복구와 요청 시 생성되는 비영속적 연속성 뷰를 제공하며, 제공자 대화와 transcript는 비정규 상태로 유지 | 제공자 간 복구는 의미론적 복구이지 제공자 세션 복원을 약속하는 것이 아닙니다. |
| 배포 | 불변 릴리스 구성, 프로젝트 초기화, OpenCode 통합, 호스트 데몬, 역할 및 절차 | Git 기반 Codex marketplace 패키지, OpenCode/Codex 런타임 경로, 선택적 네이티브 worker 및 Windows/macOS/Linux 설치 | 이 플러그인은 제공자와 호스트 범위가 더 넓지만, universal-directory 게시는 publisher 소유이며 미완성 상태입니다. |

## 이전 플러그인 설계에서 축소한 엄격한 표면

원본 설계는 조정, 컨텍스트 또는 유지보수 비용을 정당화하지 못한 영구 장치를 거부합니다. alpha.66에서 검토한 소스 범위는 실행 경계에 그 수정 사항을 적용했습니다. 아래는 역사적 비교 근거입니다. beta.16에서는 자문용 lane 분류기와 임시 메모 형식화 API를 완전히 제거하고 HEAD가 직접 판단·표현합니다.

- `ProductLearningNote`는 관찰, 가설 또는 추론된 의미를 기본적으로 일시적인 상태로 유지합니다. 여기에는 콘텐츠 ID, 그래프 노드, 영속성 또는 권한이 없습니다. Core는 Run 간 복구, 반박/감사, 제품 상태 또는 인계/컨텍스트 손실 요구에 한해서만 영속화를 권장합니다.
- `recommendOperatingLane`은 순수한 자문용 분류기입니다. Observe는 WholePlan, Capsule, Run, lease 또는 review를 추가하지 않습니다. Session은 제한적이고 되돌릴 수 있는 하나의 결과를 다룹니다. Run은 종속성, 복구 또는 독립적 검토가 필요할 때 선택됩니다. Authority는 영향을 받는 사용자 소유 경계에서만 선택됩니다.
- 제품 및 연속성 읽기는 공개된 동일 프로세스 snapshot 또는 콘텐츠 ID cache를 재사용할 수 있습니다. Core 쓰기는 이를 무효화하고, `--fresh`는 전체 검증을 강제합니다. cache는 지시, 승격 또는 복구 권한을 부여하지 않습니다.
- Initiative는 Signal이나 Hypothesis를 먼저 만들지 않고도 명시적인 inline reasoning에서 시작할 수 있습니다. Feature 해석은 승인 시점까지 미룰 수 있으므로, 검토되지 않은 제안은 기본적으로 `ProductFeatureCandidate`를 만들지 않습니다.
- 지속 작업을 위한 기존 Product Operating Loop 작업 7개는 계속 사용할 수 있지만, 더 이상 일반적인 관찰이나 계획의 필수 진입점은 아닙니다.
- `head help`는 가벼운 기본 표면만 노출하고, `head help-all`은 모든 고급, 호환성, 감사 및 복구 명령을 유지합니다. 레인 추천은 명시적으로 선택 사항이며 다른 작업을 막을 수 없습니다.

범용 red line은 그대로 유지됩니다. 인식론적 클래스는 병합되지 않고, candidate는 불변이며, review는 별도 아티팩트입니다. Product Canon은 모델 추론으로 절대 변경되지 않습니다. 외부 쓰기, 자격 증명, 중대한 Initiative 결정 및 recovery-canon 교체는 사용자 소유로 유지됩니다. 제공자 transcript, Git, GraphDB, 문서 및 어댑터는 비권위적으로 유지됩니다.

## 연결된 구현 증거

이제 기본 경로를 처음부터 끝까지 입증할 수 있습니다.

```text
read or reason
  -> ephemeral typed note
  -> advisory risk lane
  -> direct bounded work when safe
  -> immutable Initiative candidate only when durable product action is needed
  -> separate user ReviewDecision
  -> Feature resolution at acceptance
  -> accepted execution lineage for consequential implementation
```

통합 테스트는 note가 프로젝트 아티팩트나 그래프 노드를 만들지 않고, 직접 추론에는 선행 Signal/Hypothesis가 필요하지 않으며, 거부되거나 확인되지 않은 review는 아무것도 쓰지 않음을 검증합니다. 또한 수락된 review는 candidate byte를 보존하고, Feature candidate는 review 시점에만 나타나며, Product Canon은 변경되지 않고, cache hit는 공개되고 쓰기로 무효화되며, `--fresh`가 작동하고, 외부에서 변조된 캐시 아티팩트는 파일시스템 ID가 변경되면 거부됨을 검증합니다. 전체 테스트 스위트, 플러그인 검증기, Skill 검증기 및 구문 검사는 이 변경의 릴리스 게이트입니다.

## 장점과 남은 격차

제공자 중립적이고 Git 및 GraphDB를 선택적으로 사용할 수 있는 플러그인으로서, 이 저장소는 원본 런타임 구성보다 더 강한 이식 가능한 의미론을 갖습니다.

- 프로젝트, 제품, 그래프, 변경, 실행 및 복구 ID는 하나의 제공자 세션이나 하나의 호스트 데몬에 종속되지 않습니다.
- 세 가지 제공자 어댑터는 권한을 분기하지 않고 하나의 의미론적 Core를 공유합니다.
- Windows, macOS 및 Linux 설치와 정확한 하위 프로세스 정리는 테스트된 배포의 일부입니다.
- Product Canon, candidate review, temporal provenance, Context compilation, execution review 및 선택적 projection이 하나의 연결된 계약을 형성합니다.
- 이제 가벼운 일반 경로는 더 깊은 계약을 보편적인 오버헤드로 만들지 않으면서 원본의 비례성 원칙을 보존합니다.

원본에는 이 플러그인이 의도적으로 보유한다고 주장하지 않은 기능, 즉 일반적인 provider-session resume/stream 및 확립된 installed-Herdr 운영 경로가 여전히 있습니다. 이제 이 플러그인에는 제공자 중립적 host-bound 지속형 프로젝트 역할 메시징, append-only 정확 엔드포인트 대상, fresh-snapshot/ack/post-snapshot 전달 fencing, 결정론적 two-fresh-process Codex/OpenCode generic-host 증거 및 별도의 live consumer가 create-only 요청을 확인하는 프로덕션 host-export 브리지가 있습니다. 외부 호스트는 내보낸 각 엔드포인트를 현재 coordination binding과 프로세스별 proof 하나에 고유하게 결합하므로, snapshot membership이나 복사된 좌표만으로는 다른 역할의 live caller ID를 스스로 주장할 수 없습니다. 이 플러그인은 Herdr별 어댑터를 번들로 제공하지 않습니다. 이미 실행 중인 Codex/OpenCode 도구의 실제 사용, P2-first 선택적 정확 HEAD 연결, 제한된 worker dispatch/own/wait/result/review/integration 및 exact-owned one-shot interrupt/close는 이식 가능한 호스트/런타임 계약을 통해 Windows에서 검증됩니다. Automatic DAG merge/conflict resolution, Obsidian/Notion publication 및 OpenAI universal plugin-directory publication 역시 미완성 상태입니다. 이는 authority separation을 약화할 이유가 아닌 확장 격차이지만, 우월성 주장의 범위를 제한합니다.

원본 저자는 이식 가능한 연속 작업, 독립적으로 소유할 수 있는 worker, 실제 Codex/OpenCode 호스트 왕복 및 criterion-resolution 증거가 완성된 후 정확한 푸시 소스 `fd9ad3b`를 직접 감사했습니다. 해당 감사에서는 차단 수정 사항 없이 비교 판정 세 가지를 모두 무조건적으로 내렸습니다. 이후의 Claude Code, bounded-wave 및 constitutional-profile 변경 사항에는 그 정확한 소스에 대한 판정이 자동으로 승계되지 않습니다. Claude Code에는 동일한 결정론적 one-shot authorization, lease, supervisor, result, compaction 및 projection 계약이 있지만, live model-call 및 already-running-host 왕복은 별도의 opt-in 증거 게이트로 남습니다.

## 저자 검토를 위한 주장 경계

검증할 명제의 범위는 좁습니다.

> 범용 제공자 중립적 플러그인 사용 관점에서, 이 저장소는 원본 HEAD 철학을 보존하면서 더 이식성 높은 의미론, 제품 권한, 그래프, 실행 lineage 및 배포 기반을 제공합니다.

필수적인 일상 규칙 중 보호되는 결과가 없는 것이 하나라도 있거나, core 기본값이 사용자 소유 권한 전환을 우회할 수 있거나, 파생 뷰가 유일한 복구 수단이나 의미가 되거나, 원본의 이식 가능한 Core 책임이 재배치된 것이 아니라 소실되었다면 이 명제는 거짓입니다. 이미 감사된 판정은 `fd9ad3b`에 적용되며, 이후의 모든 소스 범위에는 각각 별도의 제한된 감사가 필요합니다.

## 원본 저자의 검토 결과

2026-08-20의 첫 번째 파일 메일 판정은 의도적으로 범위가 제한되었습니다. 더 폭넓은 제공자 중립적 기반 범위는 인정했지만, live coordination, portable recovery 및 worker ownership 격차가 해소될 때까지 전체적인 우월성과 철학적 우월성에 대한 판단은 보류했습니다.

이후 해당 격차는 정확한 소스 범위별 여러 차례의 작업으로 구현되고 감사되었습니다. criterion-resolution 답변 `20260820T183022Z--completeness-criterion-resolution`에서 원본 저자는 아티팩트 소유 P2 restore가 의미론적 HF-008을 충족하고, live attachment는 선택적 P5 continuity 기능이며, provider resume/stream 및 Herdr별 구현은 선택적 어댑터 기능이고, 단일 OS live 증거와 이식 가능한 Host 계약이 이식성 기준을 충족한다고 판단했습니다. 정확히 푸시된 소스 `fd9ad3baf8879bd4b92f18e1b9cf4562358d737e`에 대한 최종 판정은 다음과 같습니다.

- 차단 수정 사항: 없음.
- 철학적 우월성: 예.
- 전반적인 완전성 우월성: 예.
- 전반적인 우월성: 예.

이는 비교를 위한 자문 증거이며 Product Canon ReviewDecision이나 프로젝트 권한이 아닙니다. 또한 commit 범위에 한정됩니다. 이후의 Claude Code, bounded worker wave 및 default-core/profile 변경 사항에 대해 현재 `main`의 판정으로 주장하려면 새로운 소스 검토가 필요합니다. 현재 구현은 내장된 Herdr별 동작을 계속 제외하며, 동등한 결과에는 제공자 중립적 Host/runtime 계약 또는 별도 소유의 선택적 어댑터를 사용합니다.

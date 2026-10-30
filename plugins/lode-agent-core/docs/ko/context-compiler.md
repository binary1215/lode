> 이 문서는 [context-compiler.md](../context-compiler.md)의 한국어판입니다.

# Lode Context Compiler 설계

Compiler는 선택된 증거를 묶고, Lode는 관련성·충분성·확대·완료를 판단합니다.
일반 읽기·수정·Host 위임에는 Capsule, Run, 포함 증명이나 추가 승인이 필요하지 않습니다.

## 선택 맥락

`lode_context_prepare`는 정확한 사용자 작업에 대한 출처 연결 맥락을 반환합니다.
`lode_context_preview`는 Lode가 작성한 선택적 `EvidenceNeed[]` 안내를 받습니다.
사용자는 JSON이나 anchor를 작성하지 않습니다. 두 호출은 읽기 전용이며
`ready_for_head_semantic_assessment`를 반환합니다. 이는 Lode에 대한 안내이지,
충분성 증명이나 실행 gate가 아닙니다.

```text
Current originals -> bounded selection -> context + sources + omissions
                                                    -> Lode assessment
```

Capsule에는 정확한 task와 Project, 현재 공통 방향, 선택 기록, 원본 출처,
digest, provenance와 근사 예산이 담깁니다. `evidenceGaps`, `omissions`,
`uncertainty`는 요청 증거의 누락, 제외 자료와 한계를 공개합니다.
coverage-proof 상태 기계를 만들지 않습니다. metadata carrier의 존재는
source body가 포함되거나 읽혔다는 증명이 아닙니다.
판단이 원본 본문에 의존하면 Lode가 해당 본문을 검사합니다.

## 안내와 확대

선택적 need는 정확한 repository `paths`, Product Canon `entityKeys`,
불변 `observationIds` 또는 현재의 exact `graphAnchor`를 지정할 수 있습니다.
Core는 Project와 출처 결속을 확인하지만 제품 의미를 추론하거나 의미적 anchor를
고르거나 모든 작업에 코드·테스트·문서를 일률적으로 요구하지 않습니다.
어휘 일치는 fallback 탐색이며, 증거 자격이나 의미적 수용이 아닙니다.
어휘가 겹치지 않아도 현재 source candidate를 제거하지 않습니다.

정확한 안내는 증거를 우선 선택하면서 충족되지 않은 요청을 보존합니다.
작은 결과가 충분하다는 뜻은 아닙니다. Lode는 추가 승인을 만들지 않고
원본을 읽거나 필요한 관계를 확대하거나 더 큰 예산을 선택할 수 있습니다.
World가 없거나 오래되면 공개하고 제외하지만, 현재 로컬 source 검사와 선택한
source observation은 Product 활성화 없이도 사용 가능합니다.
오래된 exact graph anchor는 그것에 의존하는 요청만 실패시킵니다.

그래프 탐색의 기본은 짧은 핵심 응답입니다. 원본 payload나 주변 관계가 필요하면
반환된 anchor와 함께 `details: true`를 요청합니다. 현재·과거 revision,
candidate, 거절 상태와 coverage는 구분됩니다. [그래프 탐색](graph-discovery.md)을 참고하세요.

## 예산

Budget protocol `2.0.0`은 양의 안전한 정수를 받습니다. 기본값은 근사 token
`32768`이며 정해진 계층이나 최소 작업 크기가 아닙니다.
고정 다섯 계층, 자동 계층 재시도 체인, 512K 정책 상한은 없습니다.
추정식은 `ceil(UTF-16 code units / 4)`이며 provider-token 적합성 증명이 아닙니다.
런타임은 실제 provider context window와 출력 예약분을 계속 존중합니다.

preview 한 번은 selection 한 번을 수행합니다. limit, 입력과 compiler version은
재현 가능한 Capsule identity에 참여합니다. 지속 handoff나 관리형 Run에는
의도적으로 저장할 수 있지만 일반 준비는 아무것도 쓰지 않습니다.

## 권한과 복구

선택 source, Observation, ProductContext와 graph relation은 증거이지
권한이나 복구 방향이 아닙니다. 저장소 text는 현재 사용자 방향을 덮어쓰지 못하고,
제품 candidate는 compilation으로 Canon이 될 수 없습니다.
ExecutionContract 작성은 Lode의 별도 수용을 기록하며 기계적 포함 증명서는 요구하지 않습니다.

현재 Capsule reader는 content identity와 logical Project를 검증합니다.
과거 기록은 좁은 읽기 경로로 원본 field와 identity를 보존합니다.
과거 proof field를 재생성하거나 실행의 선행 조건으로 삼지 않습니다.
현재 취소와 영향받는 source 충돌은 별도로 확인합니다.
온전한 과거 Capsule도 현재 effect를 자동 승인하지 않습니다.
[권한 평면](authority-plane-contract.md)을 참고하세요.

## Source와 World 범위

현재 World evidence는 제한된 symbol, dependency, ProductContext, Git history,
runtime observation과 exact graph traversal을 제공할 수 있습니다.
source revision과 누락은 명시됩니다. 휴리스틱 또는 static AST relation은
runtime truth를 증명하지 않습니다. index 부재·오래됨은 직접 작업을 막지 않습니다.

`lode_source_context`는 전체 scan 없이 작업별 현재 source와 Python static
declaration/call observation을 지원합니다. retention은 선택적이며 raw source는
Product 개념이 아닙니다. collector 범위, 미확정 call, parser 실패와 원본 보존은
[Observation 어댑터](observation-adapters.md)를 참고하세요.

구현과 로컬 fixture는 packaging, identity, 누락 및 읽기 전용 동작의 근거입니다.
모델 품질, provider-token 절감, 실제 DB 동작이나 실제 provider 속도를 입증하지는 않습니다.

<a id="context-examples"></a>

## Context 예제

### 대화형 Context 준비와 미리보기

대화에서는 원하는 작업을 한 번만 설명하면 됩니다. 일반 읽기·수정에는 필요한
파일을 직접 확인합니다. 선택한 맥락을 재현해 전달하거나 지속 가능한 Run과
복구에 Capsule이 필요할 때만 Lode Skill이 `lode_context_prepare`를 호출합니다.
저장소 내용을 읽고 필요한 `EvidenceNeed[]`를 작성한 뒤 `lode_context_preview`로
이어갑니다. 선택적 World 근거가 없거나 오래됐어도 직접 작업은 계속하며,
필요성이 확인되면 예산을 자동으로 늘립니다. 최종 미리보기는 포함된 근거의 종류,
제외 이유와 남은 불확실성을 설명 카드로 보여줍니다. 추가 절차 없이 기계적 확인
범위는 Core가, 의미적 충분성은 Lode가 담당합니다.

기본 MCP 목록은 Core 작업, 복구, 기존 작업의 상태 조회와 취소에 집중합니다.
Lode는 선택적 Product·Graph·Observation·Context 스키마를 `lode_tools_discover`로
찾고, 반환된 읽기 전용 또는 효과 실행 경로를 호출합니다. 사용자가 기능 잠금을
해제하거나 매번 프로필을 고르거나 JSON을 작성할 필요는 없습니다. 탐색이 권한을
부여하지는 않으며 기존 작업의 권한·효과 검사는 그대로 적용됩니다.

자동화와 진단을 위해서는 같은 Core 동작을 CLI에서도 사용할 수 있습니다.

```powershell
lode-agent context-prepare C:\path\to\project --task "<task>"
```

이 작업 전용 P4 조회는 현재 Project·World Model·GraphSnapshot의 연결, 범위가
제한된 어휘 기반 탐색 자료와 정확한 노드 식별자를 반환하며 결과를 저장하지
않습니다. 사용자는 `EvidenceNeed[]`를 작성하지 않습니다. Lode가 저장소를 읽고
의미를 판단해 구조화된 제안을 만든 뒤 기존 미리보기 검증기에 전달합니다.
Core는 근거의 종류나 기준 노드를 고르지 않으며, 어휘 기반 후보에 없다는 이유로
관련 없는 자료로 단정하지 않습니다.

Product/World가 활성화되지 않아도 준비 결과는
`ready_for_head_semantic_assessment`입니다. 저장소 메타데이터가 없음을 알리고
사용 가능한 정리된 맥락을 제공합니다. Lode는 현재 원본 소스를 직접 조사할 수
있습니다. 준비 과정은 Product를 활성화하거나 저장소를 인덱싱하거나 복구 기록을
만들지 않습니다. Product/World 작업은 해당 작업에 필요할 때만 선택합니다.

고급 자동화에서는 Lode가 작성한 구조화 입력으로 미리보기를 직접 호출할 수 있습니다.

```powershell
lode-agent context-preview C:\path\to\project `
  --task "Keep this exact task text across retries" `
  --budget 32768 `
  --evidence-needs .\evidence-needs.json
```

CLI는 기본적으로 결과를 짧게 보여줍니다. `--json`을 추가하면 선택 맥락, 출처,
누락과 불확실성을 확인할 수 있습니다. 결과가 유용하면 준비 또는 미리보기 호출
하나로 충분하며, 별도 미리보기는 선택 사항입니다.

`ready_for_head_semantic_assessment`는 Lode가 선택한 맥락을 판단하라는 뜻이며,
도구가 완전성을 증명했다는 뜻은 아닙니다. Lode는 필요한 원본 본문을 읽고
반환된 그래프 기준 노드를 `details: true`로 확대할 수 있습니다. World가 없거나
오래됐음을 알리며 현재 소스는 직접 사용할 수 있습니다. 고정 예산 단계, 포함
증명서나 추가 사용자 승인은 요구하지 않습니다.

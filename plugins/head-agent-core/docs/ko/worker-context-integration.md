# Worker 컨텍스트와 Lode 통합

[영어 원문](../worker-context-integration.md)

기본은 Lode 직접 작업입니다. 일반 위임이 유용하면 사용 가능한 Host 도구에 짧은 작업 설명과 독립 소유 범위를 주고 Lode가 결과를 확인·통합합니다. 위임한다는 이유만으로 관리형 권한·원장·wave가 필요하지 않습니다. 완료분은 보존하고, 미완료 부분이 시작되지 않았거나 남은 효과가 없음을 확인한 뒤 직접/순차 수행합니다. 불확실한 중첩 효과는 재실행 전에 조사하되 독립 작업은 계속합니다.

아래 상세 계약은 지속 소유권, 복구나 효과 확인이 유용한 새로운 관리형 작업과 기존 작업에 사용합니다. CLI는 `node <plugin-root>/scripts/lode.mjs managed <command> ...`, typed MCP는 원래 schema를 발견한 뒤 `lode_tools_call`의 `execution_mode: "managed"`로 호출합니다. 원시 관리형 이름은 일반 서버에서 계속 제한하고 기존 유지관리 CLI/서버는 호환 진입점으로 남습니다. 기록·상태·wait·결과 조회와 정확한 소유 취소는 일반 진단입니다. Lode가 사용자 unlock이나 추가 승인 없이 수단을 선택하며 원래 authorization, lease와 effect 검사를 유지합니다.

라우팅은 권한 부여나 자동 실패 대안이 아닙니다. 원래 권한·lease·트랜잭션·기록 검증은 유지하며 일반 Host fork를 관리형 launch로 해석하지 않습니다. 파일 수정, worker 수나 일반 실패만으로 이 경로를 선택하지 않습니다. 모든 경로는 사용자 변경을 보호하고 Canon/P2 권한을 Lode와 사용자에게 남깁니다.

## 현재 지원 범위

Fresh one-shot 컨텍스트는 현재 관리형 어댑터의 기본값이며, 일반 Host 위임에서
항상 우선해야 하는 방식은 아닙니다. Lode는 [Skill 기준](../../skills/lode-agent-core/SKILL.md#choose-execution-and-preserve-judgment)에
따라 각 기여에 필요한 맥락으로 fork/fresh를 선택합니다. 이 판단은 B/C 선택과
별개이며 실제 어댑터 지원 범위 안에서 이뤄집니다.
선택적인 Codex native-fork Host 어댑터는
완료된 원본 turn 경계와 정확한 상속 구간을 결속하며, 앱의 fork 명령을 bounded
실행의 대체 경로로 쓰지 않습니다. 실효 정책·상속 맥락 처리·소유 transport 정리가
검증되지 않으면 native fork는 사용할 수 없습니다. 원본 turn 경계만으로 지시나
도구 격리를 증명하지는 못합니다.

Core는 worker 입력 보존, 선택 작업 폴더 결속, 분리 job 관찰과 patch·결과 통합을 제공합니다. Codex 어댑터 코드는 신뢰된 Host 정책 검증기를 통해 선택 작업 폴더 실행을 기존의 독립 lease·결과 경로에 연결합니다. 설치 기본 Host에는 이 연결을 위한 **검증된 실효 정책 backend가 아직 없습니다**. 합성 protocol·로컬 native 파일 효과 시험은 모델 권한·provider 격리·연결된 provider E2E 흐름의 완성을 증명하지 않습니다. 분리 또는 native-fork 어댑터의 부재는 해당 선택 모드에만 영향을 주며 일반 Lode 작업이나 기존 attached 실행을 막지 않습니다.

실제 App Server transport는 native 대화형 supervisor를 통해 설치된 실행 파일을
실행하고, 제한된 stdio RPC의 요청·응답을 연결하며 소유 프로세스 트리 정리를
검증합니다. 별도 읽기 전용 probe는 계정·모델 조회만 허용하며 스레드 생성,
turn 시작이나 원시 프로세스 입력 핸들 노출을 허용하지 않습니다. 이 연결은 설치된
Codex runtime에서 확인했지만 모델 worker E2E 시험이나 실효 정책 검증은 아닙니다.
Backend의 강제 기능 미구현, provider API의 불완전한 정책 관측, Host sandbox
설정은 서로 다른 문제입니다. Sandbox 설정만 완료한다고 어댑터가 활성화되지는 않습니다.

별도의 `fresh-selected-patch-proposal` backend 후보는 새 Codex worker에게
**patch 데이터만** 요청합니다. 도구나 파일 쓰기 권한을 주지 않으며, 부족한
selected-exec/native-fork 보장을 대신 증명하지도 않습니다. 소스에 고정된 runtime
구성은 `worker-prepare` / `lode_bounded_worker_prepare`와 기존 start 작업을 통해
내장 로컬 Host에 연결됩니다. 기본은 fresh입니다. 명시적인 `contextMode: "native-prefix"`
(MCP는 `context_mode`, CLI는 `--context-mode`)는 `selectedContext`로 새 controlled
durable seed를 만들고 그 child를 fork합니다. 한 번 대신 최대 두 번의 모델 turn을
사용하며, 준비 결과의 `executionPlan`이 실행 없이 이 차이를 보여줍니다. seed 보존과
두 호출은 기존 허용 범위 안에 있어야 합니다. 임의 Lode 이력의 fork, 캐시 보장,
더 강한 code-worker backend가 아닙니다. 소스 반영은 설치 캐시 반영과 다릅니다.
실제 provider E2E 검증과 backend 전체의 수용 판정은 아직 남아 있습니다.

자동 통합 상태는 관측 불가한 읽기 의존성과 쓰기 대상을 구분하고, Lode가 수행할
범위 한정 복구 행동을 안내합니다. 관측 가능성을 복구하거나 정당한 근거 재선택으로
새 제안을 준비하며, 새 digest만 제출해 unknown 근거를 우회하지 않습니다. 원래 결과는
보존합니다. 이미 시작된 미결 효과는 먼저 조정해야 하지만 무관한 일반 작업은 막지
않습니다. CLI/MCP 카드는 같은 비지속 안내를 요약하며 승인·복구 권위를 추가하지 않습니다.

## 1. 각 worker에 필요한 것만 준비

사용자는 작업을 설명하고, Lode가 목적·기대 결과·non-Lode 역할·소유 파일과 행동·관련 근거·남은 질문을 선택합니다. Brief에 담을 내용이지 사용자 작성 양식이 아닙니다. 구현에는 선택한 설계 배경이 필요할 수 있고, 독립 리뷰에는 부모의 결론보다 계약과 원자료가 유용합니다. 원시 이력이나 비밀값을 다른 provider로 자동 복사하지 않습니다.

실제 입력은 **authorization 이전**에 준비합니다.

- Session worker는 필요한 brief를 `sessionRequest`에 담고 정확히 승인된 바이트로 실행합니다.
- Run worker는 accepted plan·contract·Capsule에 결속합니다. Wave 멤버는 정확한 Run 계보를 공유하지만 authorization과 lease는 각각 독립입니다.
- `workerRole`은 dispatch 소유 기록입니다. 그 자체로 지시를 주입하거나 파일 접근 권한을 강제하지 않습니다. 필요한 지시는 승인할 입력에 넣으며 prompt를 OS sandbox로 간주하지 않습니다.

보존 입력에는 안정적인 `taskKey`, 역할·결과·선택 맥락과 선택적 `sourcePaths`를 사용합니다. Lode는 선택한 dirty/untracked 파일의 바이트도 캡처합니다. 동일 Project/Session/Run/task key는 하나의 논리적 멤버입니다. 같은 요청은 authorization을 재사용하고 변경된 입력은 소비 전에 재준비할 수 있습니다. 소비 후 모델·timeout·맥락·임의 task key 변경으로 at-most-once lease를 우회하지 않습니다. Worker 재실행에는 검증된 시작 전 실패 증거가 필요하며 실행 여부 불명은 시작 실패가 아닙니다.

선택 작업 폴더는 필요한 바이트만 별도 실행 디렉터리에 복사하며 두 번째 Lode Project를 만들지 않습니다. 정본 root와 실행 root를 따로 기록하고 의존성 완전성이나 실효 sandbox를 주장하지 않습니다. 쓰기 입력에는 정확한 원본 바이트·mode 또는 명시적 대상 부재도 캡처합니다. 실행 전에는 선택 입력과 쓰기 전 상태만 검사하며 무관한 저장소 변경을 전체 작업의 freshness 게이트로 삼지 않습니다. 파일이 같아 보여도 다른 정본 project root에서 결속을 재사용하지 않습니다.

Fresh proposal authorization `0.7`은 worker 소유 쓰기 경로 없이 읽기 전용
`proposalBasis`에 선택 대상의 원본 또는 부재를 결속합니다. Lode가 authorization
전에 선택하며, 이는 제안 가능한 대상을 지정할 뿐 모델의 수정 권한이 아닙니다.
기존 `0.6` 쓰기 실행은 바뀌지 않습니다. 고정 Codex proposal 정책은 아래의
selected-exec 정책과 별개입니다. [runtime 계약](runtime-adapters.md#새-patch-제안-backend-후보)을 참고하세요.

선택적인 Codex 정책 계획은 authorization 전에 동결합니다. 이후 신뢰된 Host가
실효 제약을 유지하는 실행 구간을 정확한 authorization·보존 입력·모델·실행 파일·두
root에 결속합니다. 이 보호는 실행과 정리까지 유지되며 lease 소비 직전 다시
검사합니다. 근거가 없다고 정본 root에서 조용히 실행하지 않습니다. 이는 Host 연결의
의무이며 사용자가 추가로 작성하는 정책 양식이나 승인 단계가 아닙니다.

계획에는 provider/model과 실제 호출 이름의 정확한 대응도 고정합니다. Native-fork
계획은 승인 뒤 다른 대화 내용을 고르는 대신 상속 구간의 digest를 authorization
전에 고정합니다. Provider thread·turn 식별자와 원시 이력은 Host-local P5에 남으며
상속 구간이 P2 복구 방향이 되는 것은 아닙니다.

정책 `0.2`는 제한 대상을 명시합니다. 모델에 보이는 작업 자료, 모델이 호출할 수
있는 도구와 그 효과, 추가 구성·상속 지시가 대상입니다. Provider의 기본 지시를
없애거나 텍스트가 모델 내부에 미치는 영향이 전혀 없음을 증명하라는 뜻은 아닙니다.
신뢰된 OS/runtime·provider 인증·Host 제어는 별도 P5 작업이지만 자동 면제는
아닙니다. Backend는 정확한 runtime 접근 제약을 검증해야 하며, 제어 데이터라는
명칭으로 미선택 작업 자료나 credential을 worker에 노출할 수 없습니다. Loader와
도구가 같은 권한으로 runtime 경로를 읽는다면 그 예외도 명시하고 제한해야 합니다.
이전 `0.1` 계획을 이 계약으로 재해석·승격하지 않으며, 계획 변경으로 이미 소비한
authorization을 재사용할 수는 없습니다.

## 2. 정확한 job 실행·관찰·취소

`worker-start` / `lode_bounded_worker_start`에는 신뢰된 Host runner capability가 필요합니다. 도구 입력으로 실행 파일·환경·정책이 강제된다는 주장을 넘길 수 없습니다. 검증된 Windows 합성 연결에서는 native owner가 runner의 절대 deadline과 자식 프로세스 트리를 관리합니다. 정확한 member·authorization·input·root·runner/Core identity·policy가 결속됩니다.

시작 요청을 반복하거나 응답이 불확실해도 같은 job을 관찰하며 새로 실행하지 않습니다. CLI와 MCP는 동일한 연산을 제공합니다.

| 목적 | CLI | Typed MCP |
| --- | --- | --- |
| 상태 관찰 | `worker-job-status` | `lode_bounded_worker_job_status` |
| 취소 요청 | `worker-cancel` | `lode_bounded_worker_cancel` |
| 반환 근거 재대조 | `worker-job-reconcile` | `lode_bounded_worker_job_reconcile` |
| 동결된 patch 조회 | `worker-job-patch` | `lode_bounded_worker_job_patch` |

상태 조회는 읽기 전용이며 artifact를 만들지 않습니다. 성공에는 owner·트리 종료, native terminal 출력, 정확한 lease release와 invocation 근거의 검증이 필요합니다. 부분 출력 파일이나 취소 요청만으로 완료를 판단하지 않습니다. 취소는 임의 PID가 아닌 기존 job만 대상으로 하며 소스 drift나 Run 전환이 보호적 취소를 막지 않습니다. 소유권은 숫자 PID 부재뿐 아니라 프로세스 생성 identity로 확인합니다.

고정 runner는 invocation 정산을 기다린 뒤 재연결한 Host를 닫습니다. 실행 파일
확인이나 정책 결속이 실패해도 해당 연결을 정리하며, 정리 실패를 job 성공으로
처리하지 않습니다. 바깥 native owner가 runner를 종료해야 하는 경우에는
JavaScript `finally` 실행을 가정하지 않고 native 트리 정리 증거를 사용합니다.

App Server transport는 비동기 초기화 전에 요청을 고정하므로 검사한 바이트와
전송할 바이트가 같습니다. 의도한 취소나 시간 초과 뒤 검증된 정리는 작업 성공이나
정리 여부 불명과 구분하며, 강제 종료 자체를 worker 성공으로 판정하지 않습니다.

쓰기 job의 owner는 lease 정산 뒤 작업 폴더 patch를 동결하고 terminal 출력에 결속합니다. 소유 범위 밖 변경과 예상하지 않은 파일을 거부하며 이후 child 편집이 동결된 후보를 바꾸지 못합니다. 원본 mode를 보존하고 materializer의 보호 권한을 의도한 소스 변경으로 해석하지 않습니다. 이러한 관찰은 원자적 파일시스템 snapshot이 아닙니다.

Fresh proposal job은 작업 폴더에 썼다는 주장이 아니라 정확한 receipt에 결속된
`RuntimeStructuredResult` `0.2`의 `patchProposal`에서 patch를 재구성합니다.
Core는 대상 경로·제안 이미지·동결된 제안 기저를 검증하며 모델이 제안한 바이트나
검증 문장을 실제 적용 효과·실행한 시험으로 간주하지 않습니다. 제안의 적합성은
여전히 Lode가 판단합니다.

Wave 완료는 운영 근거이지 전체 작업의 수용 판정이 아닙니다. 부분 실행이면 개별 job을 확인하고 강제 seal 없이 wave status/abandonment를 사용합니다. Failed·abandoned wave에도 실행 중인 멤버가 남을 수 있으며 abandonment는 프로세스를 종료하지 않습니다.

## 3. 하나의 Lode 흐름으로 변경 통합·적용

Lode는 `lode_worker_integration` 또는 동일한 `worker-integrate --input <head-integration-request.json>`을 사용합니다. 대화와 검증된 결과에서 Lode가 구조화 입력을 작성하며 사용자에게 파일 작성을 요구하지 않습니다. `lode_worker_integration_status` / `worker-integration-status`는 출처·효과·현재 의존성·겹치는 미완료 효과·전체 결과 상태를 비영속 화면 하나로 제공하며 원시 patch 바이트를 중복 출력하지 않습니다.

| Action | 역할 |
| --- | --- |
| `prepare` | 완료된 정확한 member·authorization·receipt·patch 출처를 재사용 가능한 P3 intent 하나에 동결합니다. |
| `apply` | 현재 계보·의존성·쓰기 전 상태를 확인한 뒤 지원되는 정확한 파일 효과를 적용합니다. |
| `reconcile` | Worker를 재실행하거나 성공을 추측하지 않고 보존된 효과 근거를 검사합니다. |
| `settle-incomplete` | 어떤 owner도 계속 쓸 수 없다는 정확한 증거가 있을 때 정직한 미완료 결과로 정산합니다. |
| `prepare-result` | 현재 기저에 Lode의 통합 판단과 전체 Run의 ResultPacket 제안 하나를 동결합니다. |
| `publish-result` | 정확한 결과를 기존 Run finish와 Fresh Lode 검토 경로로 발행합니다. |

같은 파일 효과는 기여한 모든 member를 보존하며 합칩니다. 실제 변경의 원본·결과 바이트 불일치, 경로 별칭·상하위 경로 겹침은 Lode가 해결할 충돌로 남깁니다. 변경하지 않은 파일과 읽기 의존성은 **예약 대상이 아닙니다**. 의존성 drift는 Lode가 재평가할 근거입니다. 현재 `basis_digest`는 그 평가를 관측 근거에 연결할 뿐 새 사용자 승인 토큰이나 기계의 의미적 충분성 판단이 아닙니다.

완료된 Run 범위의 읽기 전용 제안은 worker에게 쓰기 권한을 주지 않고 준비·검토할 수 있습니다.
실제 변경이 있는 `apply`에서만 Lode의 정확한 현재 Run 계약에 `project.write`가
필요합니다. 제안이나 소비된 runtime lease가 그 권한을 부여하지 않습니다. 빈 통합에는
쓰기 게이트를 추가하지 않으며 실제 적용은 기존 원본·소유권·native 효과 검사를 따릅니다.

적용은 claim 발행이나 첫 파일 쓰기 전에 **모든** 효과의 native 지원 여부를 검사합니다. Durable P3 claim·시작 기록·receipt로 준비, 변경 가능성, 확인된 결과를 구분합니다. Run/Session 변경이나 Host cache 유실 뒤에도 겹치는 미완료 효과가 보이며 무관한 경로나 일반 Session 작업은 막지 않습니다. 조율 잠금이 충돌 조회·claim 게시·효과 시작 사이의 경쟁을 막습니다. Claim만 있고 시작 기록이 없으면 같은 통합에서 재개합니다.

하나의 효과가 성공하고 다음이 실패하면 적용된 효과는 기록하고 나머지는 미완료로 보존합니다. 효과 사이에 새 외부 의존성 drift가 생기면 남은 효과만 Lode 재평가까지 보류하며, 이 통합이 적용한 검증된 postimage는 예상된 변화로 취급합니다. 이후 외부 수정을 이전 효과로 덮어쓰거나 전체 성공을 추론하거나 자동 rollback하지 않습니다. 명시적인 확실한 미쓰기 재시도는 같은 통합에 연결되며 정확한 owner 종료·native 미쓰기 근거·현재 원본 일치가 필요합니다(MCP의 `retry_known_no_write`). 프로세스나 cache가 사라졌다는 이유만으로 unknown을 재시도하지 않습니다.

재대조는 원래 unknown receipt를 보존합니다. 이후 정확한 native 완료 근거가 확인되면 별도의 재대조 관측을 추가할 수 있지만 postimage 바이트 일치만으로는 안 됩니다. 근거가 없으면 이를 보고하며 lease 정산이나 결과를 지어내 복구하지 않습니다. Owner가 더 쓸 수 없고 현재 효과 경로의 근거가 확인되면 실제 미완료 적용을 정산해 미완료로 보고할 수 있습니다. 성공으로 바꾸거나 사용자에게 artifact 수동 정리를 요구하지 않습니다. 이후 재대조도 이미 정산된 이력을 바꾸지 않습니다.

초기 적용이 native intent 게시 시도 전에 실패한 경우에도 기존의 명시적 미쓰기
재시도를 사용할 수 있습니다. 기본 Host transport가 정확한 요청·바이너리 결속을
준비하고 Core가 시작 기록을 남긴 다음, native 응답과 소유 자식 프로세스 종료를
검증합니다. 이에 정확히 일치하는 `intentPublication: not-attempted` 종료 증거만
해당됩니다. 현재 계보·원본·동일 journal을 다시 확인한 뒤 연결된 P3 시도를 추가하고,
같은 native intent를 create-only 충돌 검사 아래 다시 제출합니다. 이미 보존된
native 미쓰기 기록은 별도의 native 연결 재시도 경로를 사용합니다. 어느 쪽도 이력을
삭제하거나 이전 unknown을 건너뛰거나 복사된 증거를 받거나 상태 조회만으로
재시도하지 않습니다. Journal 부재·접근 불가, timeout, 소유자 미확인은 unknown이며
성공처럼 보이도록 수동 정리를 요구하지 않습니다. Lode가 기존 옵션을 사용하므로
사용자에게 새 양식을 요구하지 않습니다.

## 4. 합쳐진 상태를 검증하고 한 번 완료

Run에는 **하나의 ResultPacket**이 있습니다. 개별 worker의 통과가 합쳐진 상태를 증명하지는 않습니다. Lode가 누락·중복 작업, 효과와 의존성을 확인하고 적절한 검증을 수행한 뒤 전체 결과·정확한 member 근거·남은 unknown을 기록합니다. 의미 판단의 주체는 Lode이며 hash·Compiler·wave status·native helper가 아닙니다.

`prepare-result`는 보고서를 현재 근거 기저에 결속합니다. 효과 상태 `complete`와 `settled-incomplete`는 파일 효과의 정산 상태이지 의미적 성공 판정이 아닙니다. Core는 Lode 보고서의 문구나 검사 상태 표기로 게이트를 선택하지 않습니다. 어느 상태든 결과 준비·발행에서는 관측할 수 없는 읽기 전용 의존성을 명시적인 unknown 근거로 남길 수 있습니다. 원래 출처와 `allDependenciesObservable: false`를 보존하며 완전히 관측했다고 주장하지 않습니다.

이 보고 경로는 실행·적용 검사를 완화하지 않습니다. 실제 효과 경로는 안정적으로 관측 가능해야 하고 owner가 더 쓰지 않음과 현재 권한을 검증해야 합니다. 읽기와 효과가 겹치는 경로는 효과 규칙을 따릅니다. 이후 기저가 바뀌면 재평가와 새 검증이 필요할 뿐 영구 거절하지 않습니다. 실행 검증은 짧은 mutation lock 밖에서 수행합니다.

`publish-result`는 정확한 동결 검증과 Run만 받습니다. Finish 도중 중단되어도 그 결과를 재개하며 다른 현재 Run을 완료하지 않습니다. 과거 발행 receipt는 소스·Session drift 이후에도 읽을 수 있습니다. 발행 후에는 기존 **Fresh Lode → 명시적 ReviewDecision → 명시적 P2 checkpoint 통합** 흐름을 따릅니다. 자체 승인, Product Canon 승격, checkpoint 방향 작성은 하지 않습니다. Fresh Lode는 검증된 artifact에서 만든 검토 projection이지 독립 모델이나 대화를 보장하는 기능이 아닙니다.

Provider draft 하나가 전체 계약을 만족한다면 기존 단일 결과 경로를 유지합니다. `worker-apply`는 그 Run 결과 하나를 적용하며 fragment 누적기가 아닙니다. Run 범위의 fresh `0.7` patch 제안은 통합·Lode 검증 경로를 사용하며 단일 draft bridge가 제안을 완료된 구현으로 취급할 수 없습니다. 일반 Session worker 결과는 Lode용 근거로 남고 Run 검토 요건을 얻지 않습니다.

## 5. 권한을 바꾸지 않고 재개

Compaction·provider 손실 후에는 [Session 복구](session-recovery.md)로 검증된 P2 방향을 복원한 뒤 보존된 job·통합을 확인합니다. Transcript·provider summary·P4 status는 복구 방향을 작성하지 않습니다.

과거 근거 조회는 현재 소스·Session·role 투영 drift를 허용합니다. 새 실행·적용은 여전히 현재 경계를 검사합니다. `worker-reconcile --task-key`는 선택 소스가 바뀌어도 동결된 시도 계보에서 누락된 member 조회 기록을 복구하며 새 실행을 하지 않습니다. Job 재대조는 정확하고 완전한 출력·보존된 lease 정산·owner와 트리 종료가 검증될 때만 누락된 invocation 기록을 복원하며 정산을 추론해 만들지 않습니다.

통합 준비는 사라진 Host cache를 찾기 전에 기존 P3를 재사용합니다. 발행이 중단되면 부분 staging을 보존하고 같은 최종 identity로 수렴하며 사용자에게 파일 정리나 worker 재실행을 요구하지 않습니다. 상태를 반복 조회해도 새 기록을 만들지 않습니다. 복구는 알려진 사실을 보존하고 미완료 효과의 영향을 겹치는 경로에 한정하며 postimage가 있다는 사실만으로 적용 주체를 증명하지 않습니다.

## 구현 경계

Session 결과의 `planDelta: ""`와 `impactRadius: []`는 예시가 아닌 고정값입니다. 로컬 영향은 `outcome`/`evidence`, 파일 제안은 `patchProposal`에 기록합니다. Codex exec·fresh proposal·native-prefix child의 출력 스키마는 검증된 scope에 따라 빈 문자열 enum과 `maxItems: 0`으로 이 값을 전달하며 Run의 delta·impact는 그대로 유지합니다. Core는 응답 필드 삭제·모델 재시도·Run/wave 강제 없이 원본을 검증합니다. 배열 제약은 stock [Structured Outputs 계약](https://developers.openai.com/api/docs/guides/structured-outputs)을 따르지만 로컬 전송 시험은 실제 모델 수용 증거가 아닙니다. 새 Session 입력의 digest는 달라지며 기존 시도·실패 receipt를 수정하거나 재실행하지 않습니다.

selected-only 준비에서 기존 CLI global 지침이 발견되면 전체 backend 고장으로 표시하지 않고 `unavailable_for_selected_scope`와 비지속 안내를 반환합니다. 이 결과는 worker 실행 권한을 제공하지 않습니다. 직접 Lode 작업과 일반 Host 위임은 기존 범위 안에서 계속 가능하며, 이 투영이 다른 Host의 기능을 증명하지는 않습니다. 감사한 stock 실행 방식은 같은 인증 home을 유지하면서 해당 global 지침만 제외하지 못합니다. 인증 복제·global 설정 변경·`host-global` 전환·자동 재시도를 하지 않습니다. Lode는 정확한 global 지침 전송이 기존 사용자 승인에 포함되는 경우에만 이를 포함하거나, 그렇지 않으면 해당 범위의 승인을 먼저 받아야 합니다. 일반 작업에 반복 승인을 추가하는 규칙은 아닙니다.

- 보존 입력 `0.4`는 선택한 member 맥락, `0.5`는 선택 작업 폴더 결속, `0.6`은 정확한 쓰기 전 상태를 추가합니다. 별도 `0.7` 읽기 전용 입력은 `proposalBasis`를 추가하며 worker 쓰기 권한을 주지 않습니다. 이전 입력에 새 의미를 묵시적으로 부여하지 않으며 어느 버전도 그 자체로 실효 sandbox를 증명하지 않습니다.
- Native image-effect 경로는 Windows 로컬 NTFS, 이미 존재하는 상위 디렉터리, 일반 파일 생성·수정·삭제와 지원되는 mode 변경을 다룹니다. `0444`/`0666`은 Windows 읽기 전용 속성이며 POSIX ACL 의미가 아닙니다. 읽기 전용 파일의 바이트 수정, 새 상위 디렉터리 생성, 미지원 파일시스템·플랫폼은 적용 전에 알립니다. 빈 파일과 부재는 구별합니다. Rename 형태의 변경도 별도 효과이며 원자적 rename이 아닙니다.
- Native journal은 정확한 intent·결과 근거를 보존하지만 쓰기 중단 시 일부 바이트만 남을 수 있습니다. 다중 파일 원자성, metadata/ACL compare-and-swap, 자동 rollback을 주장하지 않습니다. 검증된 transport·JS bridge는 요청·payload를 결속하며 timeout·잘못된 출력은 미쓰기 증거가 아닌 unknown입니다.
- 통합 출처·효과·검증 기록은 P3 근거, status·basis 화면은 P4, Host 프로세스·journal 운영은 P5입니다. 개별 worker 권한을 넓히거나 P2 복구 권위를 대체하지 않습니다.
- 실제 provider 실효 제약과 전체 실모델 E2E 수용 검증은 미완료입니다. Selected-exec·선택적 native-fork 어댑터 코드와 검증된 설치 backend를 혼동하지 않습니다. 합성·native 시험은 로컬의 제한된 근거이며 그 기능의 완성이나 속도·비용 우월성의 증거가 아닙니다.
- `maxInputBytes`는 새로 직렬화한 정확한 worker 입력을 제한하며 provider가 상속한 전체 대화까지 제한하지는 않습니다. 실제 native-fork backend는 상속·신규 맥락과 지시 범위, 해당 provider의 컨텍스트·비용 경계를 별도로 검증해야 합니다. Prefix digest나 크기가 제한된 이력 조회 응답만으로는 이를 증명할 수 없습니다.

관련 계약은 [wave 연산](bounded-worker-wave.md), [실행 계보](execution-lineage.md), [runtime adapter](runtime-adapters.md), [산출물 저장 관례](artifact-storage.md)를 참고합니다.

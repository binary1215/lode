> 영어 원문: [bounded-worker-wave.md](../bounded-worker-wave.md)

# 공급자 중립적 제한 worker 실행 wave

`BoundedWorkerWave`는 Lode Core를 worker launcher, 공급자 세션 레지스트리 또는 Herdr
adapter로 만들지 않으면서 하나의 간결한 실행 wave 보기를 추가합니다. 이미 생성되고
검증된 `BoundedWorkerDispatch` 레코드를 정확히 하나의 활성 Run 계보 아래 묶습니다.

독립 dispatch의 지속 복구·효과 추적이 필요하면 새로운 유용한 작업과 기존
작업에 wave를 사용합니다. Lode 직접 작업과 일반 Host 위임도 계속 제공합니다.
파일 수정, worker 수나 일반 실패만으로 wave를 강제하지 않으며 과거 기록·상태·
대기는 일반 진단으로 남습니다.

## 권위와 정체성

| 아티팩트 | 평면 | 의미 |
|---|---|---|
| `BoundedWorkerWave` | P3 | 기존 dispatch를 묶는 create-only 증거 |
| `BoundedWorkerWaveSeal` | P3 | 모든 구성원의 권한이 실제로 소비되었다는 create-only 증명 |
| `BoundedWorkerWaveAbandonment` | P3 | seal되지 않은 부분 실행의 명시적 비성공 handoff |
| `WorkerWaveStatusProjection`, `WorkerWaveResultProjection` | P4 | 지속되지 않는 집계 보기 |
| `BoundedWorkerWaveWaitOutcome` | P5 | 제한된 운영 관찰만 수행 |

wave 생성은 기존 권한 ID 2~64개만 받습니다. `ExecutionAuthorization`을 생성하지 않고,
role, runtime, model, workspace mode 또는 action을 선택하지 않으며, 어떤 구성원의
범위도 넓히지 않습니다. 모든 구성원은 독립적인 at-most-once lease를 유지합니다.
caller handle, 공급자 세션 ID, pane, socket, TUI 명령 및 Herdr 정체성은 Core 의미
상태 밖에 있습니다.

read, status, result-read, wait는 저장된 Project·Run 관계, plan, contract,
Capsule, dispatch, authorization 해시를 검증합니다. Run 완료나 Session 교체
후에도 읽을 수 있지만 과거 근거가 새 실행·적용 권한을 부여하지는 않습니다.
create, seal, abandon은 현재 Session과 활성 실행 계보도 요구합니다.
무관한 Session 시각·checkpoint 갱신은 실행 drift가 아닙니다. 각 작업의
tamper가 있으면 fail-closed로 중단됩니다.

## 수명주기

```text
existing BoundedWorkerDispatch[]
  -> BoundedWorkerWave(open)
  -> independent worker execution and authorization consumption
  -> explicit BoundedWorkerWaveSeal
  -> WorkerWaveStatusProjection(sealed | completed | failed)
  -> optional BoundedWorkerWaveWaitOutcome
  -> Lode gathers individual evidence while the Run is valid
  -> one combined Run ResultPacket -> Fresh Lode -> ReviewDecision -> P2 integration
```

읽기 전용 status 투영은 seal을 생성하지 않습니다. seal하려면 모든 구성원의 lease
소비가 검증되어야 합니다. dispatch가 존재하거나 caller가 주장하는 것만으로는 실행
증거가 되지 않습니다. 집계 result read와 wave wait는 seal 전에 fail-closed로
중단됩니다. `completed`는 모든 구성원이 성공적인 최종 runtime result를 반환했다는
뜻입니다. 하나라도 빠르게 최종 실패하면 seal된 wave는 `failed`가 되며 절대
`completed`가 되지 않습니다.

Status와 wait는 집계 조회 가능 여부, 전체 시작 증거 유무, 시작됐지만 lease 해제
증거가 없는 멤버를 비지속 Lode 안내로 제공합니다. 프로세스 정리 완료의 증명은
아닙니다. seal 전에도 개별 job을 읽을 수 있으며 wait 중단이나 wave 포기는 멤버를
취소하지 않습니다. 성공한 결과를 보존하고 소유한 미종료 멤버를 별도로 확인·취소합니다.
CLI/MCP 카드가 이를 보여주며 사용자에게 새 양식을 요구하지 않습니다.

seal되지 않은 부분 실행에는 create-only abandonment record 하나를 둘 수 있습니다.
reason code는 고정되어 있고 선택적인 UTF-8 summary는 정규화되어 256바이트로
제한됩니다. summary에는 instruction, review, promotion, success 또는 recovery 권위가
없습니다. seal과 abandonment는 상호 배타적입니다. 동일한 retry는 수렴하고 서로 다른
retry는 실패합니다. 둘은 같은 create-only terminal slot을 두고 경쟁하므로, 동시에
seal/abandon을 시도해도 두 개의 최종 진실을 만들 수 없습니다.

wave 완료는 ResultPacket을 적용하거나, Fresh Lode review를 만들거나,
`ReviewDecision`을 생성하거나, checkpoint를 통합하지 않습니다. HF-009는 독립 worker
dispatch와 실행 소유권으로 유지됩니다. HF-010은 각 fragment가 아니라 Run의
단일 전체 결과를 명시적으로 검토하여 통합하는 경로입니다.
컨텍스트 선택, 부분 실행, 단일 worker 적용과 Lode의 통합 finish 구분은
[worker 컨텍스트와 통합](worker-context-integration.md)을 참고합니다.

## CLI와 typed MCP

```text
lode-agent managed worker-wave-create <project> --input <wave.json>
lode-agent worker-wave-read <project> --wave <bounded-worker-wave-id>
lode-agent managed worker-wave-seal <project> --wave <bounded-worker-wave-id>
lode-agent worker-wave-status <project> --wave <bounded-worker-wave-id>
lode-agent worker-wave-results <project> --wave <bounded-worker-wave-id>
lode-agent worker-wave-wait <project> --wave <bounded-worker-wave-id> [--wait-timeout-ms <0..600000>]
lode-agent managed worker-wave-abandon <project> --input <abandonment.json>
```

Typed MCP는 동일한 Core 함수와 ID를 사용합니다. 관리형 변경 schema를
발견하고 `lode_tools_call`에 `execution_mode: "managed"`를 지정하거나 기존
별도 관리형 stdio 서버를 사용합니다. CLI `managed`도 유용한 새로운 복구
작업을 지원합니다. 라우팅은 authorization을 만들지 않고 정확한 계보, lease와
시작 증거 검사를 보존합니다. 일반 MCP에는 read/status/results/wait와 정확한
소유 취소가 남습니다. Status는 자동 시작이나 seal을 수행하지 않습니다.
파일 수정, worker 수나 일반 Host 실패만으로 관리형을 선택하거나 사용자의
설치 서버를 교체하지 않습니다.

Embedding Host는 열린 Worker Admission capability를 wave status에 선택적으로
전달할 수 있습니다. 이 경우 P5 queue/reservation detail만 추가되며 wave
state machine이나 `started` 증거는 바뀌지 않습니다. capability가 없는 일반
CLI/MCP 및 Core 호출은 그대로 유지됩니다. 자세한 내용은
[worker-admission.md](worker-admission.md)를 참조하세요.

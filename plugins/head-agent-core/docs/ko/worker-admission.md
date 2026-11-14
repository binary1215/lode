> 영어 원문: [worker-admission.md](../worker-admission.md)

# 프로바이더 중립 Worker Admission

Worker Admission은 이미 생성된 `BoundedWorkerDispatch`를 위한 선택적 P5
Host 용량 경계입니다. authorization을 만들거나 모델을 고르거나 worker
scope를 넓히거나 provider session을 실행하거나 결과 수락 여부를 결정하지
않습니다. Admission을 설정하지 않은 Host에서는 기존 dispatch, runtime
lease, result, wave 동작이 그대로 유지됩니다.

## 내구성 있는 Host 도메인

Host는 `provisionWorkerAdmissionDomain(...)`으로 도메인을 한 번 생성한 뒤
`openWorkerAdmissionHost(...)`로 그 정확한 identity를 엽니다. 운영 metadata,
append-only event journal, 별도의 Host expectation intent/commit chain은 모두
프로젝트 밖에 위치합니다. 열 때 예상 domain-instance ID와 metadata hash를
반드시 제공해야 합니다. intent, commit, metadata, genesis, event 또는
event-commit marker 하나라도 없으면 해당 도메인은 unavailable입니다. 누락을
빈 queue나 여유 capacity로 해석하지 않습니다. 같은 domain ID는 다시
provision할 수 없습니다.
provision, open 및 열린 capability의 모든 사용은 기존 directory prefix를
symlink나 junction을 따라가지 않고 검증하며, 실제 경로가 설정된 Host root
안에 남는지 확인합니다. 모든 journal append는 검증된 tail과 경로 구조를
동기적으로 다시 읽고, validator가 반환된 뒤에도 generation, reservation,
lease consumption 전이를 쓰기 전에 다시 확인합니다. 따라서 Host 검증을
기다리는 동안 중간 경로가 P5 상태를 프로젝트 안으로 redirect하는 것도
허용하지 않습니다.
각 directory lock 획득은 create-only 무작위 owner token을 쓰고 디렉터리와
token 파일의 identity를 기록합니다. Host 검증을 기다린 뒤와 정리 직전에
호출자가 그 정확한 객체를 계속 소유하는지 확인합니다. lock이 이동·유실·교체된
경우에는 명시적 Host 복구 대상으로 남기므로 오래된 정리가 같은 안전한 경로를
나중에 획득한 협력적 호출자의 lock을 삭제하지 않습니다. 자신의 token을 지운
뒤에도 디렉터리 identity를 다시 확인합니다. 마지막 identity 확인과 `rmdir`
시스템 호출 사이의 간격은 임의 파일시스템 변경까지 막는 보장이 아닙니다.
Host는 domain을 명시적 복구 상태로 전환하지 않은 채 정리 중인 lock 경로를
이동해서는 안 됩니다.
expectation tree에는 genesis부터 권위가 없는 journal head도 항상 존재하며,
domain lock 안의 append마다 전진합니다. 따라서 event와 marker tail을 함께
잃어도 남은 head와 충돌하므로 이를 여유 capacity로 복원하지 않습니다.

정책은 불변이며 범위가 제한됩니다. 전역 동시성은 1-64, capacity key별
동시성은 1-전역 상한, queue 깊이는 1-1024, 최대 대기는 1초-1일입니다.
capacity key는 검증된 authorization에서만 다음과 같이 파생합니다.

```text
runtime/<exact-runtime>/model/<exact-provider-model-or-unspecified>
```

같은 key 안에서는 FIFO를 적용합니다. key 사이에서는 현재 실행 가능한 각
key의 선두 중 가장 오래된 요청을 선택하므로, 포화된 모델 하나가 다른
key의 capacity를 선점하지 않습니다.

## 최종 소비 경계

`enqueueWorkerAdmission(...)`은 capacity를 예약하기 전에 queue 요청을
기록합니다. 예약만으로 실행 증거가 되지는 않습니다. 반환되는 pre-consume
capability는 직렬화할 수 없는 branded Host capability이며,
`executeRuntimeInvocation`과 Claude, Codex, OpenCode adapter를 거치는 별도
내부 인자로만 전달됩니다. 같은 모양의 JSON 값은 capability가 아닙니다.

authoritative consumption 변수는 계속 runtime lease가 직접 소유합니다.
기존 runtime owner lock을 획득한 뒤 admission gate는 admission-domain lock
안에서 정확한 Project, Session, Run, WholePlan, ExecutionContract, Capsule,
authorization, dispatch, request generation, reservation fence를 다시
검증합니다. lease가 제공한 폐기 가능한 one-shot callback만 기존 immutable
consumption receipt를 쓸 수 있습니다. callback 전 취소나 stale lineage는
소비를 0으로 유지하고 runtime owner lock을 제거합니다.

Host 검증은 비동기이므로 validator가 반환된 뒤 소비 직전에 정확한 계보와
Host 저장 경로를 다시 검사합니다. queue 취소, timeout, validator 실패 정리는
호출한 정확한 generation만 terminal로 만들 수 있으며 이전 호출이 재개된
generation을 변경할 수 없습니다.
queued 또는 resume 검증이 끝난 뒤에도 원래 queue deadline을 다시 적용하므로,
늦게 반환된 Host 응답이 deadline을 연장하거나 뒤늦은 reservation을 만들 수
없습니다.

이미 소비된 authorization은 최초 queue event도 만들 수 없습니다. 아직
reserve되지 않은 queued 요청이 외부에서 소비되거나 사용할 수 없게 되면
정확한 generation을 취소하고 capacity를 예약하지 않습니다. 반면 cleanup이
불명확한 기존 reserved 재시작은 unknown-blocking으로 유지합니다. 이 구분은
불확실한 기존 작업을 보존하면서 실행 불가능한 새 요청의 capacity 누수를
막습니다.

소비는 성공했지만 admission start marker commit이 실패하면 provider
operation은 시작하지 않습니다. authorization은 소비된 상태로 남고 기존
lease 오류/release 정리를 수행하며, 영향받은 admission domain은 unavailable
또는 unknown-blocking으로 표시됩니다. 이 상태를 replay하거나 여유 capacity로
계산하지 않습니다.

capacity는 검증된 정확한 runtime result가 no-child 실행을 확정하거나
provider 종료 관측과 소유한 process tree 정리를 모두 증명했을 때, 또는
소비 전 실패가 입증된 뒤에만 반환합니다. runtime owner lock 해제만으로는
자손 정리 증거가 되지 않습니다. 같은 finalize 재시도는 수렴하고 다른 결과나
stale finalize는 실패합니다. 재시작한 queued 요청은 Host validator가
`current`와 `resume`을 모두 명시해야 하며 원래 deadline을 유지한 새
generation으로 기록합니다. reserved 요청은 단순 resume 주장만으로 풀지
않습니다. 사용 가능하고 소비되지 않은 runtime lease와 Host의 명시적
`current`·`resume` 검증을 모두 요구합니다. lease가 claimed 또는 consumed
상태라면 `unknown-blocking`으로 둡니다. 소비된 작업은 다시 queue에 넣지
않습니다.

## 상태와 권위

`readWorkerAdmissionProjection(...)`은 비지속 운영 projection입니다.
내부 `resumed` event는 공개 `queued` 상태로 되돌려 투영하고,
reservation/start-marker event는 `capacity-reserved`로 투영하며,
authorization 소비, supervisor/provider 시작 관측, terminal 근거는 별도
`executionEvidence`로 표시합니다. 실행 근거가 없거나 손상된 경우 reservation
상태로 추정하지 않고 unknown 또는 unavailable을 공개합니다.
`readBoundedWorkerWaveStatus(...)`는 열린 Host capability를 받은 경우에만
member별 admission detail을 선택적으로 붙입니다. capability가 없으면 기존
출력과 동작은 바뀌지 않습니다. Admission 유실은 일반 wave status나 P2
복구를 막지 않고 선택적 admission detail만 unavailable로 만듭니다.

Admission event와 projection에는 instruction, review, promotion, Product
Canon, completion 또는 recovery 권위가 없습니다. Wave의 `started`는 계속
내구성 있는 authorization consumption 또는 terminal runtime result를
뜻하며 queue나 reservation 상태를 뜻하지 않습니다. 결과 흐름은
`ResultPacket -> Fresh Lode -> 명시적 ReviewDecision -> 명시적 P2 checkpoint
통합`으로 유지됩니다.

이 단계에는 의도적으로 public CLI/MCP 표면을 추가하지 않습니다.
provisioning, Host expectation 저장, cancellation 연결 및 restart 검증은
provider-neutral Host adapter의 책임입니다. provider session ID, PID, socket,
pane, TUI 상태 및 Herdr identity는 Core semantic state에 저장하지 않습니다.

## 검증

```text
node --test test/worker-admission.test.mjs
npm run verify:runtime-lifecycle
```

targeted test는 정확한 provisioning/open, 중간 link 거부, paired-tail 유실과
의미 전이 tamper fail-closed, 최종 계보 drift, generation-fenced 취소·만료,
throwing detached validation 정리, validator 대기 구간을 포함한 소비 0회
취소, one-shot callback 폐기, available lease의 안전한 resume와 claimed
restart 차단, 같은 key FIFO, 독립 domain·process 경합, 세 runtime adapter의
guard 경로, 정상 target resolution 뒤 abort, 선택적 wave detail, 소비 후
event marker 실패, 불확실한 descendant cleanup의 capacity 유지를 검증합니다.

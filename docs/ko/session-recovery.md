> 영어 원문: [session-recovery.md](../session-recovery.md)

# Session 복원 및 검토된 result 통합

이 계약은 숨겨진 공급자 대화를 재개하거나 Herdr 전용 process, pane, CLI, socket 또는
TUI 동작을 내장하지 않으면서, 원래 Lode Session 복원 및 worker-result 통합 흐름의
공급자 중립적 결과를 구현합니다.

## 프로젝트 폴더 이동

프로젝트 폴더 전체를 이동하거나 복사했다면 Lode에 새 경로에서 이어서 작업해 달라고
요청하거나, 플러그인 폴더에서 `node scripts/lode.mjs resume "<new-project-directory>"`를
실행합니다. 같은 typed 초기화·재개 도구로 처리하며, 명시적인 논리 `session_id`를
주면 기존의 해당 Session을 선택합니다.

Project ID·기본 및 이름 있는 Session ID·체크포인트·Work 기록·World 원본을
유지합니다. 이전 Project 메타데이터의 정확한 원문을 로컬에 보존하고 ID 계보를
검증한 뒤, 현재 경로와 관리 manifest의 해당 항목만 갱신합니다. 게시 도중 중단되면
정확히 같은 미완료 변경을 이어서 완료하며, 다른 수정이나 로컬 소유자 충돌을
덮어쓰지는 않습니다. 실제 소스·어댑터는 과거 경로가 아닌 새 경로에서 읽습니다.
새 위치의 소스가 바뀌었으면 일반적인 freshness·drift 결과를 그대로 표시합니다.

옛 실행 authorization·경로에 묶인 lease·네이티브 Host 바인딩은 이전하지 않습니다.
필요한 운영 기능만 기존 계약에 따라 다시 연결합니다. 재개는 효과 재실행이나 복구
방향 변경·새 Product 검토·재온보딩을 요구하지 않습니다. 플러그인이 파일을 직접
이동하거나 옛 위치를 탐색하지 않으며, 전역에서 사본 하나만 존재한다고 보장하지도
않습니다. 사용자가 소유한 통합 파일은 보존합니다.

## 원래 Feature 매핑

원래 소스 번호는 다른 용도로 바꾸지 않고 그대로 보존합니다.

| Original Feature | 원래 결과 | 이 플러그인과의 관계 |
|---|---|---|
| HF-007 | context compaction을 거쳐 계속 진행 | 별도의 공급자 중립적 compaction recovery 계약으로 구현 |
| HF-008 | 이전 Lode OpenCode Session 복원 | artifact-only restore가 의미적 consumer input을 재현하며, 공급자 `ses_*` resume은 의도적으로 주장하지 않음 |
| HF-009 | 독립적으로 소유할 수 있는 worker task dispatch | 별도의 bounded runtime/coordination vertical에 속하며, 이 통합 transaction은 dispatch가 아님 |
| HF-010 | 완료된 worker branch 통합 | 수락된 ResultPacket review와 명시적인 Lode 소유 checkpoint 통합으로 공급자 중립적으로 표현 |

이 매핑은 동작의 동등성과 절차의 동일성을 구분합니다. 공급자 손실 연속성을 HF-010으로
이름 바꾸거나, checkpoint transaction만으로 원래 dispatch/wait lifecycle이 완결된다고
주장하지 않습니다.

## 권위 경계

| 아티팩트 | 평면 | 역할 |
|---|---|---|
| `WholePlanSnapshot`, `ExecutionContract`, `ContextCapsule`, `Run`, `SessionRunCheckpoint` | P2 | 복구 가능한 프로젝트 실행 계보 및 정확한 다음 방향 |
| `ReviewDecision` | P1 | Fresh Lode의 명시적 규범 판단 |
| `BoundedWorkerDispatch`, `ResultPacket` | P3 | worker 소유권과 result 증거; 과거 integration request/receipt 기록은 계속 읽을 수 있음 |
| `SessionRestoreProjection` | P4 | 지속되지 않으며 재현 가능한 consumer view |
| `ContinuationOutcome`, `BoundedWorkerWaitOutcome`, execution lease/process | P5 | 선택적인 live attachment 및 운영 진행일 뿐임 |
| `BoundedWorkerWave`, seal, abandonment | P3 | 동일 계보의 multi-dispatch 그룹 및 비성공 handoff 증거 |
| `WorkerWaveStatusProjection`, `WorkerWaveResultProjection` | P4 | 지속되지 않는 launch-wave view |
| `BoundedWorkerWaveWaitOutcome` | P5 | seal된 wave의 제한된 관찰일 뿐임 |

이 평면들은 지속성 순위가 아닙니다. checkpoint 생성 후 P3 ResultPacket이 없어져도 P2
방향은 바뀌지 않습니다. P1 ReviewDecision은 result를 accept할 수 있지만 P2 Session
checkpoint를 대체하지 않습니다. 통합 작업은 `purpose`, `approvedDecisions`,
`currentPosition`, `nextExpectedResult`를 명시적으로 받습니다. worker reply와
ResultPacket 어느 쪽도 이 fields를 작성할 수 없습니다.

## 독립 Session 라우팅과 현재 공통 방향

하나의 정식 Project에서 여러 논리 Lode Session을 독립적으로 라우팅합니다.
MCP `session_id` 또는 CLI `--session`은 요청 대상만 선택하며
`.lode/sessions/current.json`을 바꾸지 않습니다. 추가 기록은
`.lode/sessions/by-id/<session-id>/current.json`에 보존합니다. 기존 ID, 검토,
활성·불명 작업을 유지하고 로컬 목적·진행 변경은 다른 Session이나 공통 방향을
덮어쓰지 않습니다.

복구는 현재 공통 P2 기록의 `currentProjectDirection`도 반환합니다. goal,
constraints, decisions, cancelledActions는 과거 checkpoint 필드와 구분합니다.
과거 배포 단계가 더 최신인 공통 배포 취소를 되돌릴 수 없습니다.
`lode_project_direction_update`는 정확한 조회 `expected_direction_id`와 현재
사용자 방향을 요구하며 경합은 다시 읽고 조정합니다. 복구나 방향 기록은 실행
authorization을 만들지 않습니다. 온전한 과거 자료는 탐색할 수 있지만 읽을 수
있다는 이유만으로 현재 효과를 실행하지는 않습니다.

## 아티팩트 전용 Session 복원

`session-restore`는 현재 canonical checkpoint pointer에서 시작하여 다음을 수행합니다.

1. content-addressed `SessionRunCheckpoint`를 digest 검증합니다.
2. 현재 protocol `0.3.0`과 그 불변 `sessionPointer`를 요구합니다.
3. 과거 pointer와 선택 Session의 현재 사실을 구분합니다. 기본 `current.json`과 추가 `by-id/<session-id>/current.json`은 독립적으로 유지됩니다.
4. 현재 WholePlan과, 활성 상태인 경우 정확한 Run, ExecutionContract 및 ContextCapsule
   digest를 다시 검증합니다.
5. ResultPacket 증거가 있으면 보류 중인 review 계보를 다시 검증합니다.
6. 결정적이고 지속되지 않는 `SessionRestoreProjection`을 반환합니다.

읽기 전용 프로젝트 경험은 동일한 검증을 실행해 `no-current-checkpoint`,
`verified-current-checkpoint` 또는 `attention-required`를 보고할 수 있습니다.
이 준비 상태 뷰는 복구 방향을 반환하거나 continuation token을 소비하거나 공급자를
연결하지 않습니다. Lode는 검증된 현재 체크포인트가 있을 때만 전체 복원 프로젝션을
읽습니다.

projection 0.2는 checkpoint 의미와 현재 실행 사실을 분리합니다. 옛 위치·다음 결과는
`consumerInstruction.historicalCheckpointContext`에 표시하고 현재 지시로 재발행하지
않습니다. pointer 차이만으로 복구를 거부하지 않되 변조·소유/참조 모순·현재 필수
계보 유실은 관련 작업에 표시합니다. 공급자 ID·transcript·summary를 사용하거나
resume/streaming을 활성화하지 않습니다. [상태 분리](recovery-state-separation.md)를 참조하세요.

`lode_conversation_enter`는 필요한 현재 진입 맥락이 아직 제공되지 않았을 때 같은
읽기 전용 restore와 범위 제한 프로젝트 상태 사실을 구성합니다. Skill은 정확한
Project와 선택된 논리 Session의 검증된 맥락이 충분하면 현재 공통 방향·취소 사항과
함께 재사용하고, 관련 기준이 바뀌면 영향을 받는 현재 원본만 확인합니다. 사용자가
recovery를 요청하거나 identity를 입력하거나 두 번째 status 호출을 수행하게 하지
않습니다. 일반 진입의 World 상세 검사는 명시적으로 미검사이며 최신·오래됨·부재가
아닙니다. 필요하면 전체 status/doctor 진단을 사용할 수 있지만 필수 후속 절차는
아닙니다. 현재 checkpoint가 없으면 일반 작업을 계속하고, 검증 실패는 Lode에
배정되어 recovery 의존 작업만 멈춥니다. 명시적 `session-restore`는 진단 및 adapter
통합용으로 계속 제공됩니다.

checkpoint 생성 후 P3 ResultPacket 증거가 삭제되었더라도 restore는 정확한 P2 방향을
반환하고 증거를 `missing-evidence`로 표시합니다. Fresh Lode review context를 만들어내지
않습니다. caller는 review 전에 필요한 증거를 복구하거나 재현해야 합니다.

## 읽기 전용 checkpoint 진단

`lode_checkpoint_diagnose`는 현재 pointer가 있을 때 프로젝트 준비도와 대화 진입이
공통으로 사용하고 typed MCP와 고급 CLI가 노출하는 읽기 전용 P4 진단입니다. 현재
checkpoint pointer 또는 그 부재,
artifact-only restore 검증, 기계적인 checkpoint-sync 가능 여부와 범위가 한정된 다음
Lode 동작 하나를 보고합니다. lock, cache, checkpoint, Session pointer, 승인 또는 Canon을
쓰지 않습니다. 이를 읽는 것만으로 다른 provider Lode나 model 평가를 호출하지 않습니다.

현재 pointer가 있으면 진단은 `basis B0 -> artifact restore -> basis B1` 순서를 수행합니다.
정상 결과에는 동일한 basis identity와 Session hash, 그리고 restore tuple의 정확한 Project,
Session, checkpoint ID와 checkpoint digest 일치가 필요합니다. 관찰이 바뀌면 결과는
`observation-changed-retry`이며 두 읽기를 정상 상태로 합치지 않습니다. 이는 순차적인
filesystem 관찰이지 원자적 snapshot이 아닙니다. 읽기 사이의 변경 후 복원 ABA를 감지할
수 없다는 사실도 projection에 명시합니다.

projection은 다음 사례를 구별합니다.

- 현재 pointer 없음
- pointer가 가리키는 checkpoint ledger 파일 누락
- checkpoint 또는 필수 lineage의 구조/digest 실패
- 필수 Session, Run, lineage 또는 Capsule artifact 누락
- Session이나 필수 lineage가 drift한 검증된 checkpoint
- 선택적 P3 ResultPacket 증거가 누락됐지만 P2 복구는 검증된 상태
- 읽기 순서 중 state 변경

선택적 ResultPacket 누락은 자체 완결적인 P2 방향을 무효화하지 않지만, review 의존 작업에는
그 증거가 필요합니다. 필수 artifact 누락이나 integrity 실패를 선택적 누락, staleness 또는
부재로 낮추지 않습니다. artifact 복구와 sync 가능 여부는 별도 축입니다. 안정적으로 관찰된
pointer drift 때문에 기존 checkpoint를 복원할 수 없어도 새 Lode-authored 방향은 기계적으로
게시 가능할 수 있습니다. 어느 사실도 의미적 최신성을 증명하지 않습니다. ID, hash 또는
basis byte가 같아도 자연어 방향이 최신 사용자 의도를 여전히 나타내는지는 알 수 없으며,
checkpoint 작업이 실질적으로 필요할 때만 현재 provider Lode가 이를 평가합니다.

## 최신성 gate를 적용한 checkpoint 동기화

일반 provider Lode 작업은 Session checkpoint를 무조건 다시 쓰지 않고 다음
read-derive-sync 순서를 사용합니다.

```text
lode_checkpoint_basis (read-only P4 comparison)
  -> current provider Lode derives direction from that exact basis
  -> lode_checkpoint_sync (locked P2 publish or exact reuse)
```

비지속 basis는 정확한 Project와 Session, 현재 checkpoint, Session record hash,
Run/WholePlan/ExecutionContract/Capsule 및 review reference, Run 게시 전이와 현재
compaction epoch를 결속합니다. Core는 게시 직전에 기존 Session-recovery mutation
lock 안에서 이 basis를 다시 구축합니다. basis는 동시성 증거이지 복구 방향이나 승인이
아닙니다.

동기화 결과는 네 가지입니다.

- `created`: 새 content-addressed checkpoint 하나를 게시하고 Session pointer를
  전진시켰습니다.
- `reused`: 현재 checkpoint가 같은 정규화된 방향과 정확한 현재 lineage를 이미
  가지므로 ledger와 Session pointer를 모두 쓰지 않았습니다.
- `deferred`: 미완료된 정확한 Run 전이 또는 open compaction epoch 중 바뀐 checkpoint를
  먼저 처리해야 합니다. 독립적인 일반 작업은 계속할 수 있습니다.
- `conflict`: 전달된 basis가 오래됐거나 기록된 Run 전이가 현재 Session state와
  충돌하므로 복구 byte를 쓰지 않았습니다.

변하지 않은 basis와 방향에 대한 checkpoint identity는 결정론적입니다. ledger 게시
전, ledger 게시 후 Session pointer 게시 전, pointer 게시 후의 재시도는 두 번째 ledger
entry 없이 수렴합니다. 동시에 들어온 동일 호출은 `created`와 `reused`로 수렴하고,
동시에 들어온 다른 방향은 먼저 게시된 방향을 덮어쓸 수 없습니다.

Core는 identity, lineage, transition state와 byte 동등성만 증명할 수 있습니다. 모델이
실제로 자연어 방향을 다시 검토했는지는 증명할 수 없습니다. Provider Lode는 반환된
basis를 읽은 *뒤* 방향을 도출해야 하며, 이전 방향에서 `expectedRecoveryBasisId`만
바꾸는 것은 caller 계약 위반입니다. 이 계약은 사용자 확인 단계를 만들지 않습니다.

안정된 pending review는 유효한 checkpoint boundary입니다. 완료되지 않은 finish 또는
review 게시에서는 그렇지 않습니다. sync는 정확한 기존 Run 작업이 누락된 Session write를
완료할 때까지 `deferred`를 반환합니다. 일반 sync는 `reviewedRunIntegration`을 받거나
만들지 않습니다. 정확히 현재 상태인 integrated checkpoint는 재사용할 수 있지만, 바뀐
방향이나 lineage는 binding 없는 checkpoint를 만듭니다. accepted-result binding은 계속
`run-integrate-checkpoint`만 소유합니다.

짧은 Observe 작업, conversation entry, status read와 Host hook 부재는 첫 checkpoint를
만들지 않습니다. 신뢰할 수 있는 Host는 자연스러운 context-loss, handoff 또는 durable-Run
boundary에서 이 순서를 호출할 수 있습니다. 기존 checkpoint에 사용자 objective/constraint
변경, 검증된 단계 완료, failure/wait 전환 또는 전체 task 완료를 반영해야 할 때도 provider
Lode가 사용할 수 있습니다. 먼저 durable recovery direction을 실제로 게시할 필요가 있는지
판단하므로 매 turn의 필수 호출이 아닙니다. daemon, timer, turn마다 추가되는 model call 또는
provider-session identity도 필요하지 않습니다.

Protocol `0.1.0` 및 `0.2.0` checkpoint는 audit 및 compaction compatibility를 위해
checkpoint reader로 계속 읽을 수 있습니다. 그러나 immutable Session pointer보다 이전
형식이므로 현재 artifact-only restore를 구동할 수 없습니다. 공개 `lode-agent checkpoint`
명령은 이제 canonical content-addressed P2 형식만 씁니다. 과거의 직접 time-based API는
폐기되었으며 `latestCheckpoint`를 전진시킬 수 없습니다.

## 제한된 검토 result 통합

연결된 흐름은 다음과 같습니다.

```text
BoundedWorkerDispatch (P3)
  -> at-most-once lease / supervised provider / bounded wait (P5)
  -> ResultPacket (P3)
  -> deterministic Fresh Lode review projection
  -> explicit accept ReviewDecision (P1)
  -> explicit integration input owned by Lode/user direction
  -> SessionRunCheckpoint (P2)
```

`worker-dispatch`는 등록된 non-Lode role 하나를 정확한 현재 Run의
`ExecutionAuthorization`에 바인딩합니다. 같은 role은 멱등적으로 retry할 수 있습니다.
경쟁 role과는 충돌하며, 권한은 한 번만 소비할 수 있습니다. `worker-wait`는 지속되지
않는 운영 outcome을 반환합니다. WholePlan을 변경하거나, recovery direction을
제공하거나, ReviewDecision을 생성할 수 없습니다. `worker-apply`는 검증된 네이티브
supervision을 갖춘 완료된 실제 공급자 result만 받아 ResultPacket과 Fresh Lode review
context만 생성합니다. 명시적 review와 아래의 통합 transaction은 분리된 상태로 남습니다.

여러 기존 dispatch는 공급자 중립적 wave 계약인
[`bounded-worker-wave.md`](bounded-worker-wave.md)를 통해 볼 수 있습니다. wave seal은
result acceptance가 아니라 start-evidence aggregation입니다. wave `completed`는 모든
구성원이 운영상 성공했다는 뜻입니다. 구성원별 authorization·lease·반환 증거는
독립적으로 보존하지만, 각 구성원마다 ReviewDecision이나 checkpoint 게시를
요구하지는 않습니다. 여러 worker가 참여한 Run은 Lode가 개별 증거를 모아 통합
basis를 평가하고 하나의 전체 Run ResultPacket을 게시합니다. 그 전체 결과에 대해
Fresh Lode 검토·명시적 ReviewDecision·HF-010 checkpoint 통합을 거칩니다.
wave 완료는 이 단계를 실행하거나 남은 구성원을 종료하지 않습니다. 위의 단일
worker `worker-apply` 경로와는 구별하며,
[`worker-context-integration.md`](worker-context-integration.md)를 참조하세요.

## P2 우선의 선택적 live continuation

`session-continue`는 공급자 또는 workspace host를 확인하기 전에 항상 artifact restore를
호출합니다. 신뢰할 수 있는 host-injected adapter는 그 후 정확한 현재 Lode attachment를
새로 검증할 수 있습니다. 이 adapter의 `ContinuationOutcome`은 P5이며 지속되지 않습니다.
`attached` 또는 공개된 `fresh-logical-head` fallback 중 하나를 기록하고, 동일한 checkpoint와
restore projection을 유지하며, 공급자 summary 또는 transcript를 읽지 않습니다. 공급자
session identifiers는 canonical하지도, 지속되지도 않습니다. 따라서 attach failure는
HF-008 semantic recovery가 아니라 대화 편의성만 바꿉니다.

`run-integrate-checkpoint`는 정확히 검토된 Run과 ReviewDecision을 요구합니다. Core는
무엇이든 쓰기 전에 Run, ResultPacket, WholePlan, ExecutionContract, ContextCapsule,
Fresh Lode review identity, 현재 Session state 및 `accept` disposition을 다시 검증합니다.
`revise`, `expand`, `rollback`, `escalate`는 정상적인 next-plan 또는 user-direction 경로에
남으며 result integration으로 잘못 표시될 수 없습니다.

ReviewDecision 하나는 recovery checkpoint 하나에 결속됩니다.
lock 안의 발행은 exact reviewed lineage와 Lode가 명시적으로 작성한 방향을
checkpoint에 저장합니다. 동일 재시도는 재사용하고 다른 방향은 충돌합니다.
ledger와 Session pointer 사이에서 중단되면 누락된 pointer 갱신만 완료합니다.
뒤에 생성된 checkpoint를 재시도가 되돌리지 않습니다.

새 integration은 별도 request나 receipt를 만들지 않습니다.
과거 request와 receipt 형식은 좁은 reader로 원본 bytes를 바꾸지 않고 읽습니다.
현재 builder는 과거 request-ID 입력 변형을 받지 않습니다. 이미 기록된 과거
checkpoint는 재시도에서도 원래 identity를 유지합니다. 검증된 원본 request만
남아 있으면 읽기는 `legacy_integration_pending`을 반환하고, integration은
`RUN_RESULT_LEGACY_INTEGRATION_PENDING`을 보고하며 쓰거나 자동 완료하지 않습니다.
원본 입력은 P3 참조 근거이며 복원된 P2 방향이 아닙니다. Lode가 실제 상태와 현재
공통 방향을 살펴 여전히 적용할 수 있는 작업만 수동으로 이어갑니다. 추가 사용자
승인이나 일반 작업 전체 차단은 없습니다. 손상된 원본은 해당 읽기·통합에만 영향을 줍니다.
ResultPacket은 참조 증거로 남으며 나중에 없어져도 checkpoint의 자체 완결적인
방향이 바뀌지 않습니다. review, 운영 완료와 checkpoint 발행은 의미상 구분되지만
중복 승인 절차를 만들지 않습니다.

## 공개 표면

아래 worker 변경은 중단 복구, 소유권이나 효과 추적이 유용할 때 새로운
관리형 작업에도 사용합니다. CLI `managed`, 또는 도구 발견 후
`lode_tools_call`의 `execution_mode: "managed"`로 호출합니다.
기존 `managed-maintenance` CLI/서버도 호환 진입점으로 유지합니다.
라우팅은 기존 authorization, lease, lineage와 effect 검사를 보존하며 추가
사용자 unlock은 필요하지 않습니다. 일반 read/status/wait와 정확한 소유 취소는
계속 제공됩니다. 복구, worker 수, 파일 수정이나 일반 Host 실패만으로 관리형을
강제하지 않습니다.

```text
lode-agent checkpoint <project> --summary <text> [--next <text>]
lode-agent checkpoint-basis <project>
lode-agent checkpoint-diagnose <project>
lode-agent checkpoint-sync <project> --input <head-direction.json>
lode-agent session-restore <project> [--checkpoint <checkpoint-id>]
lode-agent session-continue <project> --runtime <codex|opencode> [--checkpoint <checkpoint-id>]
lode-agent managed worker-dispatch <project> --authorization <authorization-id> --role <non-head-role>
lode-agent worker-wait <project> --authorization <authorization-id> [--wait-timeout-ms <milliseconds>]
lode-agent managed worker-execute <project> --authorization <authorization-id> --role <non-head-role>
lode-agent managed worker-apply <project> --authorization <authorization-id>
lode-agent managed worker-wave-create <project> --input <wave.json>
lode-agent managed worker-wave-seal <project> --wave <bounded-worker-wave-id>
lode-agent worker-wave-status <project> --wave <bounded-worker-wave-id>
lode-agent worker-wave-wait <project> --wave <bounded-worker-wave-id>
lode-agent managed worker-wave-abandon <project> --input <abandonment.json>
lode-agent run-integrate-checkpoint <project> --input <integration.json>
lode-agent run-integration-read <project> --review <review-decision-id>
```

Typed MCP는 `lode_checkpoint_basis`, `lode_checkpoint_diagnose`,
`lode_checkpoint_sync`, continuation,
dispatch/status/wait/apply, restore 및 명시적 integration을 노출합니다. basis, restore,
diagnosis, status 및 wait는 read-only입니다. checkpoint sync는 멱등적이며 공통 mutation lock 안에서
정확한 basis를 다시 검증합니다. continuation은 주입된 host-local
P5 attachment만 새로 고칠 수 있습니다. dispatch와 application은 멱등적인 project-state
write입니다. 어느 것도 review, Canon, publication 또는 external-action authority를
부여하지 않습니다.

fresh-process test는 서로 다른 Codex 및 OpenCode provider-session 환경 값으로 restore를
실행하고, 어느 값도 result에 들어 있지 않은 동일한 projection identity를 요구합니다.
반례는 Session pointer drift, 누락된 ResultPacket 증거, non-accept review, divergent replay
및 CLI/MCP parity를 다룹니다.

`npm run verify:hostless-session-recovery`는 resident-consumer proof를 추가합니다. 하나의
fresh process가 통합하고, 독립적인 Codex/OpenCode labeled process가 동일한 projection을
복원하여 하나의 read-only next move를 실행하며, 주입된 inbox text는 해당 move를 작성할
수 없습니다. 검증기는 checkpoint 발행 전후 중단, 독립 writer,
상이한 integration과 non-accept review도
다룹니다. Git repository, GraphDB, WorkspaceHost, Herdr process 또는 provider session
resume은 필요하지 않습니다.

## 제한된 발화 참조와 native 연결 부재

선택적인 로컬 발화 참조는 비밀값을 가린 평문 P5 힌트입니다. 암호화·전체 대화·
지시문·P2 복구 정본이 아닙니다. 참조 전용 저장 경로는 POSIX에서 디렉터리 0700,
임시 파일 0600으로 생성하고 소유한 일반 파일인지 검사하며 안전하지 않은 링크는
거부합니다. 기존 참조도 제한된 크기로 읽어 재가림한 뒤 사용합니다. 가림은 알려진
자격 증명 패턴에 대한 최선의 처리이며 모든 비밀값을 탐지한다는 보장은 아닙니다.
Windows에서는 발화 전용 디렉터리와 단일 링크 일반 파일에 현재 token SID와 SYSTEM만
허용하는 보호 DACL을 적용합니다. 숨김·시간 제한 Windows PowerShell/.NET 검사로
ACL을 다시 확인하며 POSIX mode를 Windows 근거로 삼지 않습니다. 동일 동기 호출 안의
같은 파일시스템 항목에만 검증을 재사용하고 호출자·턴 사이에는 캐시하지 않습니다.
일반 operational 디렉터리의 ACL은 바꾸지 않습니다. 검증기 부재·비소유 항목·안전하지
않은 링크에서는 비공개 저장 성공을 주장하지 않고 캡처·재사용을 생략합니다. 로컬 helper
시작 비용이 추가되며, 동일 사용자·관리자·커널 접근 방어, 암호화, 과거 노출의 취소를
보장하지 않습니다. 선택적 저장 실패는 해당 힌트만 생략하며 일반 직접 작업은 막지 않습니다.
기존 디렉터리·파일 검사는 고정 helper 요청 하나로 묶고 새 임시 파일은 평문을 쓰기 전에
별도 검사합니다. helper는 공개 호출 하나에서 단조 시계 기준 5초 예산을 공유하며 실패한
검사를 같은 호출 안에서 재시도하지 않습니다. hook은 이 선택적 작업을 동기적으로
기다리므로 성능상 무지연·비차단을 보장한다는 뜻은 아닙니다.

Claude native 호출자 연결이 없을 때 Project 기본 Session을 통해 다른 논리
Session을 조용히 고르지 않습니다. 정확한 논리 Session을 명시한 요청과 명시적인
initialize/resume은 계속 사용할 수 있습니다. 최근 시각이나 다른 호출자로부터
old→new native ID 연속성을 추정하지 않습니다. 합성 라우팅 검사는 실제 Claude
`/clear`의 ID 변경이나 ID 간 자동 복원 성공을 의미하지 않습니다.

참조 준비만으로 저장본을 소비하지 않습니다. 실제 context 문자열 한도에 전체 참조가
들어가야 추가하며, 들어가지 않으면 보존합니다. 부분 포함을 지원한다고 주장하지 않습니다.
명령 Hook은 로컬 stdout 쓰기 callback이 성공한 뒤, OpenCode는 여전히 유효한 출력 slot에
실제로 반영한 뒤 소비합니다. `write(false)`는 실패가 아닌 backpressure입니다. 같은 출력
객체를 재구성할 때는 이미 넣은 참조도 유지합니다. private P5 nonce 소유 잠금으로 쓰기를
직렬화하며, 준비 이후 저장 세대가 바뀌었으면 이전 준비본의 소비가 새 내용을 지우지 않습니다.
정리 실패나 출력 직후 중단에서는 힌트가 중복될 수 있습니다. 이는 Host 수신·모델 활용·
정확히 한 번 전달의 증명이 아닙니다.

Claude/Codex가 직접 전달하는 `Stop.last_assistant_message`에서 크기를 제한하고 비밀값을
가린 최종 표시 본문을 보존합니다. transcript·도구 본문은 읽지 않습니다. Codex의 `turn_id`는
캡처한 prompt 자신의 turn과 일치해야 합니다. 공개 Hook 계약에는 다음 prompt가 이전 Stop의
응답이라는 명시 predecessor가 없으므로 인접성은 `unverified`, 승인은 `not-inferred`입니다.
Host prompt는 자동 continuation·예약 작업·메시지일 수도 있어 인간 출처도 `unverified`로
표시합니다. 누락/null은 제안을 만들지 않고 StopFailure의 오류 본문은 제외합니다.
OpenCode assistant 인접성은 미지원입니다. 최근 맥락과 불확실성을 보존하는 기능이며
제안·응답 쌍 전체가 복원됐다는 뜻은 아닙니다.
공개 필드 계약: [Codex Stop](https://learn.chatgpt.com/docs/hooks#stop),
[Claude Stop input](https://code.claude.com/docs/en/hooks#stop-input).

## 복구 이후에도 남는 명시적 작업

HEAD는 기존 `lode_session_work_record` 또는 checkpoint의 선택 work evidence에 `todos`를
기록할 수 있습니다. 사용자는 평소처럼 작업을 말하며 HEAD가 stable `todoId`, task,
기록된 출처, 명시 status와 미해결 작업의 next action을 작성합니다. `partial`, `waiting`,
`completed`, `cancelled`를 구분하고 대기·취소 사유를 남깁니다. 실제 진행과 관련 정확한
evidence는 P3 기록이며 프로세스 상태로 추정하지 않습니다. 갱신은 같은 Session의 정확한
`prior`를 인용합니다. 갈라진 갱신은 conflict로 보이고, 다른 분기를 명시한 `resolves`로
조정할 수 있습니다. 시각으로 승자를 고르지 않으며 이전 입력 재시도가 작업을 다시 열지 않습니다.

`workContext.todoContext`는 최근 work 기본 8개와 별개로 알려진 미해결 작업을 선택합니다.
entry/resume과 제한된 Host startup에서도 현재 P2 방향·취소 아래 읽습니다. 기존 재생성 가능한
graph index는 탐색 힌트만 제공하고 선택된 Todo 원본은 다시 검증합니다. 미검사 원본이나
색인 유실·손상은 coverage unknown이며 빈 목록·완료의 증명이 아닙니다. 읽기 때문에 색인을
수리하거나 World를 갱신하거나 독립 작업을 막지 않습니다. `lode_session_work_read`의
`todo_id`, `after_todo_id`, 또는 `scan_todos`·`after_evidence_id` 원본 페이지로 확장합니다.
CLI `session-work-read --input`은 이에 대응하는 camelCase Core 필드를 받습니다.
누락 ID·개수·이어읽기를 공개하며 P4 투영이 실행 권한이나 P2를 만들지 않습니다.
`todos`가 없는 기존 기록의 bytes/ID는 유지됩니다.

같은 요청에서 이미 검증한 원본의 작업 메타데이터도 재사용합니다. 색인 발행이 늦은 새
기록도 추가 스캔·색인 수리 없이 즉시 함께 읽으며, 모순된 힌트는 공개하고 유효한 원본을
막는 게이트로 쓰지 않습니다.

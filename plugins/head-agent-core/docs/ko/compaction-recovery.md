> 이 문서는 [compaction-recovery.md](../compaction-recovery.md)의 한국어판입니다. 코드, 명령, 프로토콜 식별자와 필드 이름은 원문 표기를 유지합니다.

# Compaction 복구

저장된 P2 방향과 선택된 작업·Todo 근거에서 이어갑니다. 지원 Hook의 제한된 prompt/final-response 참조는 인용된 P5 맥락이며 전체 대화 저장이나 현재 승인이 아닙니다. 관리형 자동 continuation에는 검증된 Host adapter가 필요합니다. 일반 읽기 전용 진입과 fork 안내가 이 lifecycle을 구현하지는 않습니다. [Host 지원](session-work-context.md)을 참고하세요.

Compaction은 손실을 수반하는 provider 작업입니다. 복구 권한은 canonical Session/Run checkpoint에 그대로 남으며, provider transcript, compaction summary, provider-session identity와 `LodeContinuitySnapshot`은 방향 파악용 또는 파생 view일 뿐입니다.

Protocol `0.3.0`은 [`authority-plane-contract.md`](authority-plane-contract.md)의 P2 recovery/lineage boundary를 내장합니다. ResultPacket이나 Worker Report는 P3 증거이며 checkpoint의 purpose, approved decision, current position 또는 정확한 next expected result를 읽기 위한 선행 조건이 아닙니다. checkpoint 생성 후 ResultPacket 증거를 삭제하는 상황은 실행 가능한 복구 test로 다룹니다. 그렇다고 summary, graph, inbox 또는 provider session이 복구 권한으로 바뀔 수는 없습니다.

Checkpoint authority metadata는 복구 field가 명시적인 Lode/사용자 방향과 검증된 P2 lineage에서만 온다고 명시합니다. P3 증거는 감사를 위해 참조될 수 있지만 복구 field의 출처가 되는 일은 절대 없습니다. 일반 비증폭 test는 P3, P4, P5가 P2가 되려는 시도를 거부합니다.

## 자동 대화 UX

project 진입, compaction 후, provider 교체 후에는 정확한 Project와 선택된 논리
Session에 대해 이미 제공된 검증된 현재 맥락이 충분하면 현재 공통 방향·취소 사항과
함께 재사용합니다. 필요한 내용이 없으면 일반적인 읽기 전용
`lode_conversation_enter`로 한 번 가져옵니다. 관련 기준이 바뀌면 영향을 받는 현재
원본을 확인하며 setup/status/list/graph 호출 전체를 반복하지 않습니다. 진입 결과는
다음 세 가지로 제한됩니다.

- 현재 checkpoint가 검증되어 정확한 P2 방향이 복원됩니다.
- checkpoint가 없어서 복구 gate 없이 일반 작업을 계속합니다.
- checkpoint 무결성에 주의가 필요해 checkpoint 의존 작업만 멈추며 방향을
  지어내지 않습니다.

같은 호출은 범위가 한정된 프로젝트 상태, Attention, 로드된/구성된 패키지 버전과
표시 투영도 포함하므로 일반 진입에서 별도의 status 호출이 필요하지 않습니다.
일반 진입은 World 상세 검사를 명시적으로 미검사 상태로 두며, 이를 최신·오래됨·부재로
해석하지 않습니다. 필요하면 전체 status/doctor 진단을 사용할 수 있지만 필수 후속
절차는 아닙니다.
복구 검증 실패는 사용자 결정이 아니라 `headActionRequired`입니다. 독립적인 보호
결정이 실제로 대기 중이지 않으면 `userDecisionRequired`는 false이며,
`ordinaryWorkBlocked`도 false로 유지됩니다.

사용자는 checkpoint identity, lifecycle event, trusted turn counter 또는
continuation token을 입력하지 않습니다. 명시적인 `session-restore`와
`compact-*` command는 고급 진단 surface로 남습니다.

복구 상태에 설명이 필요하면 프로젝트 준비도와 대화 진입은 동일한
`lode_checkpoint_diagnose` 계약을 재사용합니다. 이 계약은 `basis B0`를 읽고 artifact
restore를 검증한 다음 `basis B1`을 읽으며, 관찰이 바뀌면 새로 읽도록 요구합니다. lock이나
cache를 쓰지 않고 model을 호출하지 않으며 원자적 filesystem snapshot이나 ABA 감지를
주장하지 않습니다. pointer 부재, pointer가 가리키는 ledger artifact 누락, integrity 실패,
필수 lineage drift와 선택적 P3 ResultPacket 누락은 서로 구별됩니다. sync 가능 여부 필드는
기계적 상태일 뿐 checkpoint 문장이 현재 사용자 의도를 여전히 반영한다는 주장이 아닙니다.

이미 open 상태인 compaction epoch 바깥의 자연스러운 durable-work 또는 context-loss
boundary에서 provider Lode는 `lode_checkpoint_basis` 다음에 `lode_checkpoint_sync`를
사용할 수 있습니다. 첫 호출은 비지속 읽기 전용 비교이고, 두 번째 호출은 기존 mutation
lock 안에서 같은 정확한 Project/Session/Run 및 게시 상태를 다시 검증합니다. 상태와 방향이
같으면 write 없이 현재 checkpoint를 재사용합니다. 오래된 방향은 충돌하고, 미완료 Run
전이 또는 open epoch 중 바뀐 방향은 해당 sync만 연기합니다. 사용자에게 저장, 승인 또는
protocol field 입력을 요구하지 않습니다. [`session-recovery.md`](session-recovery.md#최신성-gate를-적용한-checkpoint-동기화)를
참조하세요.

## 상태 전이

```text
idle -> prepared -> verified -> continued
                  \-> superseded
                  \-> aborted
```

`compact-prepare`는 다음 내용을 갖는 content-addressed `SessionRunCheckpoint`를 만듭니다.

- `purpose`
- `approvedDecisions[]`
- `currentPosition`
- `nextExpectedResult`
- 현재 Session mode, Run/review pointer, 마지막 result/review reference와 필수 next-plan action을 포괄하는 immutable `sessionPointer`
- Run이 active일 때 검증된 active-Run pointer
- 선택 사항인 검증된 accepted-Run integration reference
- open review reference

active-Run pointer는 정확한 Run, WholePlanSnapshot, ExecutionContract와 ContextCapsule digest를 결속합니다. 복구 방향은 Capsule이 아니라 checkpoint가 소유합니다.

immutable Session pointer는 exact one-shot continuation 대상을 검증합니다. 일반 artifact 복구는 과거 의미와 현재 실행 사실을 분리하며 과거 pointer와의 일치가 필요하지 않습니다. Protocol `0.1.0`과 `0.2.0` checkpoint는 감사를 위해 계속 digest-readable하지만 완전한 pointer는 포함하지 않습니다. [상태 분리](recovery-state-separation.md)를 참조하세요.

[Session 복구와 검토 결과 통합](session-recovery.md)에 일반 복구 계약이 있습니다.

같은 작업은 하나의 `CompactionEpoch`도 만듭니다. epoch에는 checkpoint identity, 준비 시점의 real-user-turn sequence, state와 추측 불가능한 continuation token에 결속된 hash가 담깁니다. raw token은 한 번만 반환되며 지속되지 않습니다. provider-session identity는 저장되지 않습니다.

`compact-verify`는 명시적인 provider-success 증거와 현재의 신뢰된 real-user-turn sequence를 받습니다. checkpoint와 현재 Session/Run pointer를 다시 읽어 digest를 검증합니다. 더 새로운 실제 사용자 turn이 있으면 continuation은 superseded됩니다. Provider failure, checkpoint tamper, state drift 또는 non-canonical recovery source가 있으면 복구를 abort하거나 거부합니다. Core는 누락된 방향을 summary에서 채우지 않습니다.

`compact-continue`는 atomic at-most-once token 소비 전에 현재 checkpoint, Session, Run과 epoch를 재검증합니다. 새 checkpoint 또는 사용자 turn은 이전 continuation을 무효로 만듭니다. 정확한 checkpoint-bound 방향을 반환하며 두 번째 소비는 실패합니다. 검증은 epoch 갱신 하나만 기록하고 별도 파생 recovery receipt나 중간 provider-compacted 쓰기를 만들지 않습니다.

Prepare는 현재 checkpoint를 바꾸기 전에 입력과 기존 open epoch를 검증합니다.
Session/Run 복구를 변경하는 작업은 프로젝트 로컬의 임시 P5 lock을 공유하며,
조회는 lock을 취득하지 않습니다. 경합 시 호출자에게 해당 작업의 재시도를 안내할
뿐 사용자에게 승인을 요구하지 않습니다. 준비 중 프로세스가 중단되면 다음 변경
호출에서 전달 여부가 불확실한 token epoch만 닫고, 실제 게시된 완전한 P2
checkpoint는 보존합니다. 이는 프로세스 중단 복구이며 전원 손실까지의 내구성을
보장하지는 않습니다. 종료가 확인된 로컬 소유자의 lock은 회수할 수 있지만,
소유권이 불명확하거나 다른 host의 소유자를 종료됐다고 추측하지 않습니다. PID가
재사용되면 Host에서 소유 관계를 확인하고 운영 lock을 정리해야 할 수 있습니다.
Core는 오래됐다는 이유만으로 사용 중일 수 있는 lock을 빼앗지 않으며, 이러한
제한이 읽기 전용 조회나 일반 작업을 막지는 않습니다.
해제 시 자신의 lease만 제거하고 공유 부모인 `.lode/.operations`는 유지합니다.
이 빈 디렉터리 하나는 고정된 P5 컨테이너이며, 작업마다 새로 쌓이는 아티팩트가 아닙니다.

continuation 소비 기록은 저장됐지만 epoch를 종료 상태로 저장하지 못했다면, 조회는
아무것도 고치지 않고 결과가 불확실하다고 표시합니다. 다음 변경 호출은 정확히 해당
P5 epoch만 aborted로 닫으며 token을 재실행하거나 provider 실행을 주장하지 않습니다.
Lifecycle 재시도는 현재의 검증된 P2 방향을 복원하고 보류된 event를 확인 처리하며,
추가 사용자 승인 없이 새로운 논리적 Lode로 이어갑니다. 확인 응답이 유실돼도 새
artifact 없이 재시도할 수 있고, 이후 새 prepare도 가능합니다. 종료 처리와 조회
어느 쪽도 checkpoint를 작성하지 않습니다.

## Provider-neutral Host lifecycle 경계

Core는 provider compaction을 호출하지 않습니다. 주입된 Host adapter는 한 번에
하나의 journaled `conversation-entry`, `provider-replaced`,
`before-compaction` 또는 `after-compaction` event를 노출할 수 있습니다. 고정
descriptor는 P5이며 recovery/instruction/promotion authority가 없고 불확실한
mutation을 replay하지 않음을 보장합니다. Event는 정확한 Project, Lode Session,
runtime, 단조 증가하는 trusted real-user-turn sequence를 포함하고,
post-compaction에서만 epoch와 `succeeded`, `failed`, `uncertain` 중 하나의
bounded outcome을 포함합니다. Provider session ID, transcript, summary, prompt,
credential, PID, socket 및 UI identity는 이 계약에서 거부됩니다.

`lode_compaction_lifecycle_step`은 운영 field를 사용자에게 노출하지 않고 event를
처리합니다.

1. compaction 전에는 가능한 경우 정확한 현재 checkpoint를 재사용합니다. 새
   복구 방향이 필요하면 provider Lode가 현재 사용자 방향, 기존 승인된 결정 및
   검증된 P2 lineage만으로 작성합니다. 승인을 지어낼 수 없으며 사용자에게
   schema 입력을 요구하지 않습니다.
2. raw token은 Host adapter에만 P5로 보관되며 lifecycle 결과로 반환되거나
   project Canon에 지속되지 않습니다.
3. 성공이 보고되면 Core가 artifact-only P2 복원을 먼저 수행한 뒤 정확한
   epoch/checkpoint/current turn을 검증하고 최대 한 번 소비합니다.
4. 새 실제 사용자 turn은 기존 continuation을 supersede합니다. uncertain outcome은
   verify, continue 또는 자동 replay하지 않습니다. Provider failure는 epoch만
   abort합니다.
5. P2 복원이 성공한 뒤 transport continuation을 사용할 수 없다면 epoch를 닫고
   검증된 artifact에서 새로운 논리적 Lode로 계속함을 명시합니다.

Codex와 Claude는 이미 패키지의 `SessionStart` hook으로 기록된 Lode 맥락을
전달하며 `compact`도 포함합니다. Codex는 root Session 압축 뒤 즉시 이어지는
모델 요청 전에 이 hook을 실행합니다.
[Codex hook 계약](https://learn.chatgpt.com/docs/hooks#sessionstart)을 참고하세요.

OpenCode V1 플러그인은 각 모델 요청의 `experimental.chat.system.transform`에
읽기 전용 맥락을 추가합니다. 요약 요청과 다음 일반 요청 모두에 적용하며,
압축 직후 정확히 한 번 실행되는 이벤트는 아닙니다. 지원 근거는 OpenCode
v1.19.0의 `733b2c627e5aec39cb33cc22373bdce33053ef2c` 소스입니다.
Code-mode/V2는 지원 주장에 포함하지 않습니다. 사용자·요약 prompt와 다른
플러그인의 system 문장은 보존합니다. 매번 정확한 native Session·Project·경로를
확인한 뒤 기존 선택 Session과 현재 공통 제약을 읽습니다. 선택이 없거나
상실돼도 기본·부모 Session으로 대신하지 않으며 일반 작업을 막지 않습니다.

추가 맥락은 기존 Codex 전달 경계와 같은 32,768 UTF-16 문자 이내이며,
Claude의 10,000문자 경계는 유지합니다. 이는 직렬화 용량 경계이고 맥락이
충분하다는 판정은 아닙니다. 빠진 내용은 기존 누락 안내와 원문 참조로 확인합니다.

Claude Code와 Codex는 `UserPromptSubmit`의 최근 사용자 `prompt` 텍스트를
제한된 로컬 참조로 저장합니다. 텍스트는 project Canon 밖에 있습니다.
`PreCompact`는 그 참조를 고정하고 hook 결정을 반환하지 않습니다.
`SessionStart`의 `compact`와 `clear`는 기존 문자 상한에 여유가 있을 때만
이를 덧붙입니다. 참조는 권한이 없다고 표시됩니다. checkpoint가 복구 원천으로
남습니다.

OpenCode는 `message.part.updated`의 사용자 텍스트를 저장합니다. prompt를
담는 별도의 pre-compaction 이벤트는 없으므로 그 메시지 이벤트가 캡처
지점입니다. `experimental.session.compacting`이 참조를 고정합니다.
`session.compacted`와 이름이 `clear`인 `command.executed` 이벤트는 이후
`experimental.chat.system.transform` 한 번을 위해 표시합니다. 그 transform은
여유가 있을 때 한 번 덧붙이며 일반 turn에서는 덧붙이지 않습니다. 호스트가
`/clear`에 대해 `command.executed`를 보내지 않으면 OpenCode에는 `/clear`
신호가 없습니다.

이 전달은 기록된 원문과 그 제한된 prompt 참조를 읽습니다. checkpoint·압축
epoch를 만들거나, 실행을 승인하거나, 관리형 일회성 continuation을 구현하지
않습니다. 관리형 lifecycle에는 기존의 정확한 증거를 제공하는 신뢰된 Host
adapter가 여전히 필요합니다. 로컬 SDK stub·고정 소스 소비 경로·생성 패키지
시험은 설치된 Host나 실제 모델 실행의 증거가 아닙니다. 선택적 연동이 없어도
일반 작업은 계속할 수 있습니다.

```text
lode-agent compact-prepare <project> --input <recovery.json>
lode-agent compact-verify <project> --input <verification.json>
lode-agent compact-continue <project> --input <continuation.json>
lode-agent compact-status <project>
lode-agent compact-abort <project> --input <abort.json>
```

상태를 변경하는 command는 고급 `help-all` 작업이고, 읽기 전용
`compact-status`는 가벼운 진단으로 남습니다. Observe와 일반 Session 작업은
기본적으로 epoch를 만들지 않습니다. active Run은 provider compaction 전에
자연스러운 idle boundary에서 prepare해야 합니다. Compaction은 open review를
승인하거나, Product Canon 또는 candidate 바이트를 변경하거나, 외부 write를
수행하지 않습니다. 명시적 prepare는 Lode가 작성한 P2 방향을 새 checkpoint로
게시할 수 있지만, provider compaction과 continuation이 그 방향을 작성하거나
대체하지는 않습니다.

일반 checkpoint sync는 open epoch를 닫거나 abort하거나 대체하지 않습니다. 정확한
checkpoint 재사용은 artifact와 pointer를 쓰지 않으며, 바뀐 방향은 기존 compaction
전이가 자체 terminal path에 도달할 때까지 기다립니다. 따라서 운영 복구가 새로운 전역
작업 gate가 되지 않습니다.

Host 통합은 `lode_conversation_enter`와 `lode_compaction_lifecycle_step`도 사용하지만,
이는 사용자 설정 절차가 아닙니다. adapter가 주입되지 않으면 lifecycle step은
일반 작업을 막지 않는 unavailable 결과를 냅니다.

prepare input 예시:

```json
{
  "runtime": "codex",
  "userTurnIdAtPrepare": 42,
  "purpose": "Preserve the accepted whole outcome",
  "approvedDecisions": ["The provider summary is not recovery canon"],
  "currentPosition": "Implementation is complete; integrated verification remains",
  "nextExpectedResult": "A verified integrated test result",
  "openReviewIds": []
}
```

Verification에는 `epochId`, `checkpointDigest`, `currentUserTurnId`, `providerCompacted: true`가 필요합니다. Continuation에는 `epochId`, 일회용 `continuationToken`, `currentUserTurnId`가 필요합니다.

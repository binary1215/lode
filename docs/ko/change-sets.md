> 이 문서는 영어 원문 [`change-sets.md`](../change-sets.md)의 한국어 번역입니다.

# 제공자 중립적 ChangeSet 및 검토된 영향

이 계약을 변경하기 전에 [`architecture.md`](architecture.md)와
[`authority-plane-contract.md`](authority-plane-contract.md)를 읽으세요.

## 목적과 권한

ChangeSet record protocol `0.3.0`은 Git commit, branch, provider 또는 executor attempt와 독립적으로 검토된 하나의 logical change를 기록합니다. ChangeSet은 다음으로부터만 생성됩니다.

- ExecutionContract ContextCapsule에 고정된 검증된 World Model 및 temporal GraphSnapshot;
- 서로 다른 현재의 post-execution World Model 및 SourceSnapshot;
- 일치하는 ResultPacket;
- 수락된 execution ReviewDecision.

ChangeSet은 추가, 수정 및 제거된 `File`, `Symbol`, `Test` revision을 정확히 기록합니다. 검토된 change-lineage status를 갖지만 instruction authority 또는 promotion authority는 없습니다. 새 기록은 생성 전에 이미 관측한 정확한 `worldModelId`, `graphSnapshotId`, `sourceSnapshotId`를 각 endpoint에 고정합니다. 조회 시 보관된 World의 identity·Project·graph/source 쌍을 직접 검증하므로 관련 없는 snapshot 목록을 탐색할 필요가 없습니다. World ID는 정확한 보관 근거의 위치이며 권한을 부여하지 않습니다. Git과 독립적인 graph/source revision, ResultPacket, ReviewDecision이 의미적 근거로 유지됩니다. 기존 record `0.1.0`·`0.2.0` 원문은 두-key endpoint와 bytes·hash·ID를 유지하며, 제한된 pair 조회는 부분 탐색으로 표시할 수 있습니다. state·impact candidate·impact review는 protocol `0.2.0`을 유지합니다. Git은 나중에 선택적 `VcsEvidence`를 첨부할 수 있으며, `.git` directory 또는 commit identity는 필요하지 않습니다.

## 2단계 identity 경계

pre-change snapshot과 post-change snapshot은 ChangeSet이 존재하기 전에 고정됩니다. 그런 다음 후속 World Model rebuild가 ChangeSet을 projection합니다. 이는 자기 참조적인 graph identity를 방지합니다. ChangeSet을 추가하면 GraphSnapshot 및 World Model projection은 변경되지만 이미 고정된 observed SourceSnapshot identity는 변경되지 않습니다.

ChangeSet은 정렬된 0개 이상의 `parentChangeSetIds`를 포함합니다. protocol `0.1.0`부터 여러 parent가 유효합니다. automatic merge, ancestry discovery, conflict detection 및 conflict resolution은 계속 유예됩니다.

## 영향 candidate 및 review

plugin은 정확한 before/after revision을 비교하고, 기존에 검토된 `IMPLEMENTS` 및 `VERIFIED_BY` receipt만 따라 Feature 또는 Capability impact를 추론합니다. inference는 불변 `ChangeImpactCandidateSet`을 생성하며, `IMPACTS`를 직접 생성하지 않습니다.

명시적 change-impact ReviewDecision은 다음 중 하나를 수행할 수 있습니다.

- `accept-all`;
- 지정된 candidate ID와 함께 `accept-selection`;
- `reject`.

acceptance는 별도의 불변 `ReviewedImpact` receipt와 검토된 `ChangeSet -[:IMPACTS]-> Feature|Capability` edge를 생성합니다. rejection은 canonical impact edge를 생성하지 않습니다. candidate node는 일반 traversal과 모든 Context Capsule에서 계속 제외됩니다. 명시적 read-only traversal은 이를 포함하도록 선택할 수 있습니다.

acceptance에는 정확한 candidate evidence가 현재 상태여야 한다는 조건이 계속 적용됩니다. 명시적 `reject`는 freshness를 주장하지 않으므로 오래된 정확한 candidate set을 닫을 수 있습니다. Core는 파생 World view만 먼저 갱신한 뒤 rejection을 기록합니다. 불변 P1 `ReviewDecision`은 재구축 가능한 P4 World/Graph projection과 변경 가능한 state pointer보다 먼저 기록됩니다. 뒤의 쓰기가 실패하면 변경되지 않은 재시도는 그 정확한 영속 결정을 재사용하고, 사용자에게 결정을 다시 요구하지 않은 채 누락된 projection 또는 pointer만 복구합니다. 충돌하는 재시도는 fail closed됩니다. 레거시 orphan P4 projection은 현재의 명시적 요청, 전체 projection digest, review digest, source identity 및 모든 비파생 drift 검사가 일치할 때만 복구할 수 있습니다. Graph는 누락된 권한을 제공하지 않습니다.

변경된 code 또는 test를 Product Canon에 연결하는 검토된 mapping이 없으면 candidate set은 열린 Unknown을 기록하고 `awaiting-evidence` 상태로 유지됩니다.

## 선택적 VCS 증거

VCS evidence protocol `0.1.0`은 명시적으로 선택된 하나 이상의 Git commit observation을 기존 ChangeSet에 첨부합니다. attachment command는 현재 다이제스트가 검증된 `GitDecisionHistory`에 존재하는 commit object ID만 허용합니다. timestamp, message, diff, branch name 또는 executor session에서 equivalence를 추론하지 않습니다.

불변 `VcsEvidence` artifact는 정규화된 `GitCommitObservation` record와 이를 검증한 Git-history identity를 포함합니다. 이를 통해 `.git`, Git executable 또는 원래의 history adapter를 사용할 수 없는 경우에도 나중에 GraphSnapshot을 재구성할 수 있습니다. attachment는 ChangeSet을 편집하지 않으며 그 hash에 Git identity를 추가하지 않습니다. 다음 항목만 projection합니다.

```text
ChangeSet -MATERIALIZED_AS-> VcsEvidence -REFERENCES-> GitCommit
```

이러한 node와 edge는 `instructionAuthority: false`, `promotionAuthority: false`, `evidence-not-instruction`을 갖는 derived evidence입니다. commit은 ChangeSet도 아니며 implementation이 Product Canon을 충족한다는 증거도 아닙니다. missing history, unknown commit ID, source drift, artifact tampering 및 active/pending Run conflict가 있으면 attachment는 fail-closed 방식으로 실패하며, Git과 독립적인 모든 operation은 계속 사용할 수 있습니다.

## 명령

```text
node scripts/lode.mjs change-set-record <project> --input <change-set.json>
node scripts/lode.mjs change-set-status <project>
node scripts/lode.mjs change-set-read <project> --change-set <change-set-id>
node scripts/lode.mjs change-impact-candidates <project> --candidate-set <candidate-set-id>
node scripts/lode.mjs change-impact-review <project> --input <review.json>
node scripts/lode.mjs change-impact-review-read <project> --review <review-decision-id>
node scripts/lode.mjs change-set-vcs-attach <project> --input <vcs-evidence.json>
node scripts/lode.mjs change-set-vcs-read <project> --vcs-evidence <vcs-evidence-id>
```

최소 recording input:

```json
{
  "resultPacketId": "result-packet-<24-hex>",
  "reviewDecisionId": "review-decision-<24-hex>",
  "parentChangeSetIds": []
}
```

`beforeWorldModelId`는 선택 사항입니다. 생략하면 core가 ExecutionContract ContextCapsule에 고정된 정확한 World Model을 복구합니다. 현재 post-change World Model은 fresh 상태여야 하고 서로 다른 SourceSnapshot을 포함해야 합니다.

review input:

```json
{
  "candidateSetId": "change-impact-candidates-<24-hex>",
  "disposition": "accept-all",
  "acceptedCandidateIds": [],
  "rationale": "Reviewed revision evidence supports the impact."
}
```

VCS evidence attachment input:

```json
{
  "changeSetId": "change-set-<24-hex>",
  "commitIds": ["<40-or-64-hex-git-object-id>"],
  "rationale": "This verified commit observation materializes the reviewed logical change."
}
```

읽기 전용 MCP tool `lode_change_set_status`와 `lode_vcs_evidence`는 어떤 것도 기록, 검토 또는 promote하지 않고 검증된 state와 attachment를 노출합니다. 정확한 영속 impact decision이 있지만 state pointer 반영이 남았다면 status는 `requiresNewUserDecision: false`인 복구 상태를 표시하고 변경되지 않은 결정을 재시도하도록 안내합니다.

## 프로젝트 아티팩트

```text
.lode/change-sets/current.json
.lode/change-sets/records/change-set-*.json
.lode/change-sets/impact-candidate-sets/change-impact-candidates-*.json
.lode/change-sets/impact-review-decisions/change-impact-review-decision-*.json
.lode/change-sets/vcs-evidence/vcs-evidence-*.json
```

모든 artifact와 pointer는 콘텐츠에서 파생되고 다이제스트로 검증됩니다. source drift, 수락되지 않은 execution review, 일치하지 않는 ResultPacket/ReviewDecision, 누락된 pinned snapshot, stale candidate identity, tampering, active/pending Run conflict 및 빈 revision difference는 fail-closed 방식으로 실패합니다.

## 유예된 경계

CI 또는 filesystem event로부터 ChangeSet 자동 생성, 추론된 commit-to-ChangeSet matching, 일반 execution-lineage graph projection, merge automation, imported ticket/backlog adapter, document review receipt를 이후 graph에 projection하는 작업, Obsidian/Notion projection 및 GraphDB acceleration은 계속 유예됩니다. 비차단 공급자 Lode Conformance candidate는 별도의 P3/P4/P5 subsystem으로 활성화되며 이 blocking impact-review state pointer를 재사용하지 않습니다. [Conformance 재정](conformance-reconciliation.md)을 참고하세요. 명시적 DocumentChangeCandidate review/application은 활성화되어 있지만 ChangeSet을 생성하거나 ChangeSet authority를 변경하지 않습니다.

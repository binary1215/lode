> 이 문서는 [release-observation.md](../release-observation.md)의 한국어판입니다. 코드, 명령, 프로토콜 식별자와 필드 이름은 원문 표기를 유지합니다.

# Release observation

상태: 프로토콜 `0.1.0`에 따른 provider-neutral 관측 vertical이 구현되어 있습니다.

Lode는 제품 Git ref 상태와 호스트가 제공한 배포 결과를 기록하지만, 어느 쪽도 배포 권한, 제품 결정 또는 복구 방향으로 취급하지 않습니다.

## 흐름과 권한

```text
current product Git refs + verified reachable Git history
  -> BranchStateObservation (P3 observed evidence)

host deployment observer
  -> DeploymentResultObservation (P3 observed evidence)

approved + succeeded + exact reachable commit + matching current product ref
  -> ReleaseObservation (P3 observed evidence)
  -> P4 GraphSnapshot projection
```

`ReleaseObservation`은 릴리스가 관측됐다는 사실을 기록합니다. 배포를 허가하거나, 결과를 승인하거나, 제품 성공을 판정하거나, Product Canon을 변경하거나, `ReviewDecision`을 만들거나, P2 복구 상태를 쓰지 않습니다. `approved`와 `approvalEvidenceDigest`는 호스트 관측기가 보고한 내용을 보존할 뿐이며 Core 내부에서 사용자 권한을 만들어 내지 않습니다.

Git ref 이동만 발생하면 `BranchStateObservation`만 생성됩니다. 실패, 취소, 미승인, 도달 불가 또는 현재 ref와 불일치하는 배포는 `ReleaseObservation`을 만들지 않습니다. 도달 가능하지만 ref와 일치하지 않는 commit은 상태가 `awaiting_matching_product_ref`인 검증된 `DeploymentResultObservation`으로 남습니다.

## Adapter 경계

`StructuredDeploymentResultAdapter`는 기준 `DeploymentResultAdapter`입니다. adapter는 `authority: observed-evidence-only`, `providerNeutral: true`, `persistsProviderIdentity: false`를 보고해야 합니다. Provider run ID, session, process, socket, credential, UI identity는 semantic artifact 밖에 남습니다. Adapter는 bounded semantic field와 SHA-256 evidence digest만 제공합니다.

정확한 입력 형태는 다음과 같습니다.

```json
{
  "environmentKey": "production",
  "status": "succeeded",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "observedAt": "2026-09-01T00:00:00.000Z",
  "sourceEventKeyDigest": "<sha256>",
  "deploymentEvidenceDigest": "<sha256>",
  "approved": true,
  "approvalEvidenceDigest": "<sha256>",
  "changeSetId": null,
  "vcsEvidenceId": null
}
```

`sourceEventKeyDigest`는 provider event ID를 저장하지 않으면서 replay를 결정적으로 만듭니다. 동일한 replay는 같은 content identity로 수렴합니다. 같은 key에 서로 다른 content가 들어오면 `DIVERGENT_DEPLOYMENT_RESULT_REPLAY`로 실패합니다.

`changeSetId`와 `vcsEvidenceId`는 선택 사항이지만 함께 제공해야 합니다. 제공되면 Core는 P4에 `DEPLOYS`를 투영하기 전에 정확한 `VcsEvidence`가 정확한 `ChangeSet`에 속하고 배포된 commit을 포함하는지 검증합니다.

## Graph projection

P4 graph는 `BranchStateObservation`, `DeploymentResultObservation`, `ReleaseObservation` node를 추가합니다. `AT_REVISION`, `OBSERVED_ON`, `EVIDENCED_BY`, 선택적 `DEPLOYS` relation을 사용합니다. `GitCommit` node는 P3 branch state에 포함된 digest-verified commit observation에서 재구축되므로 live Git history를 조회하지 않아도 graph를 다시 만들 수 있습니다.

## CLI

```text
lode-agent release-observe <project> --input <deployment-result.json>
lode-agent release-status <project>
```

## MCP

- `lode_release_observe`
- `lode_release_status`

`lode_release_observe`에는 `confirm_host_observation: true`가 필요합니다. 이 확인은 모델이 실수로 만든 입력의 수집을 막지만, 배포 승인이 아니며 관측 결과에 권한을 더하지 않습니다.

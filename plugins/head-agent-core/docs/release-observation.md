# Release observation

Status: implemented provider-neutral observation vertical under protocol `0.1.0`.

Lode records product Git ref state and host-supplied deployment results without treating either source as permission to deploy, a product decision, or recovery direction.

## Flow and authority

```text
current product Git refs + verified reachable Git history
  -> BranchStateObservation (P3 observed evidence)

host deployment observer
  -> DeploymentResultObservation (P3 observed evidence)

approved + succeeded + exact reachable commit + matching current product ref
  -> ReleaseObservation (P3 observed evidence)
  -> P4 GraphSnapshot projection
```

`ReleaseObservation` records that a release was observed. It does not authorize the deployment, approve the result, judge product success, mutate Product Canon, create a `ReviewDecision`, or write P2 recovery state. `approved` and `approvalEvidenceDigest` preserve what the host observer reported; they do not manufacture user authority inside Core.

Git-only movement creates `BranchStateObservation` records. A failed, cancelled, unapproved, unreachable, or ref-unmatched deployment never creates `ReleaseObservation`. An unmatched but reachable commit remains a verified `DeploymentResultObservation` with status `awaiting_matching_product_ref`.

## Adapter boundary

`StructuredDeploymentResultAdapter` is the reference `DeploymentResultAdapter`. An adapter must report `authority: observed-evidence-only`, `providerNeutral: true`, and `persistsProviderIdentity: false`. Provider run IDs, sessions, processes, sockets, credentials, and UI identities remain outside semantic artifacts. The adapter supplies only bounded semantic fields and SHA-256 evidence digests.

The exact input shape is:

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

`sourceEventKeyDigest` makes replay deterministic without persisting a provider event ID. An identical replay converges on the same content identity. Different content under the same key fails with `DIVERGENT_DEPLOYMENT_RESULT_REPLAY`.

`changeSetId` and `vcsEvidenceId` are optional but must be supplied together. When present, Core verifies that the exact `VcsEvidence` belongs to the exact `ChangeSet` and contains the deployed commit before projecting `DEPLOYS`.

## Graph projection

The P4 graph adds `BranchStateObservation`, `DeploymentResultObservation`, and `ReleaseObservation` nodes. It uses `AT_REVISION`, `OBSERVED_ON`, `EVIDENCED_BY`, and optional `DEPLOYS` relations. The `GitCommit` node is reconstructed from a digest-verified commit observation embedded in the P3 branch state, so the graph remains rebuildable without consulting live Git history.

## CLI

```text
lode-agent release-observe <project> --input <deployment-result.json>
lode-agent release-status <project>
```

## MCP

- `lode_release_observe`
- `lode_release_status`

`lode_release_observe` requires `confirm_host_observation: true`. The confirmation prevents accidental model-authored ingestion; it is not deployment approval and does not add authority to the observed result.

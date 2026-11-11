# MCP 도구 표면과 폐기 예정 이름

[영어 원문](../mcp-surface.md)

Lode는 작은 기본 MCP 도구 목록만 나열하고, 나머지 작업은 discovery와 두 라우터로
사용할 수 있게 합니다. 0.3부터 같은 자원에 대한 작업은 `action`을 받는 도구
하나로 묶입니다.

## 기본 목록

일반 `tools/list`의 도구는 22개입니다. 여기에는 `lode_tools_discover`,
`lode_tools_read`, `lode_tools_call`이 포함됩니다. 묶음은 이 목록을 바꾸지 않고,
discovery와 managed maintenance `tools/list`에 보이는 것만 바꿉니다.

Claude 네이티브 Hook helper `lode_session_host_request_prepare`는 카탈로그 도구가
아닙니다. `tools/list`, discovery, router 어디에도 보이거나 라우팅되지 않으며,
동봉된 PreToolUse Hook만 이 helper를 호출합니다. 이전 버전은 이 helper를 23번째
도구로 나열했습니다.

## 묶음 도구

묶음 도구는 자원 이름을 따릅니다. 예를 들어 `lode_bounded_worker_wave`입니다.
`action`은 기존 작업 하나를 정확히 고릅니다.

```json
{
  "name": "lode_tools_call",
  "arguments": {
    "name": "lode_bounded_worker_wave",
    "execution_mode": "managed",
    "arguments": { "action": "seal", "project_root": "/path/to/project", "wave_id": "bounded-worker-wave-0123456789abcdef01234567" }
  }
}
```

- **경로.** 각 action은 원래 작업의 경로를 유지합니다. 읽기 전용 action은
  `lode_tools_read`로 호출합니다. `lode_tools_read`는 읽기 전용이 아닌 action을
  거부합니다. discovery는 `actions`를 반환하며, action마다 `invokeWith`, 필수
  필드, `executionMode`를 알려 줍니다.
- **managed action.** 원래 작업이 managed mutation인 action(위의 `seal` 등)은
  그 작업과 똑같이 `lode_tools_call`에 `execution_mode: "managed"`가 필요합니다.
  없으면 ordinary 표면이 `MANAGED_OPERATION_NOT_ON_DEFAULT_SURFACE`로 거부합니다.
  표에 이런 action이 표시되어 있고, discovery는 `executionMode: "managed"`로
  알려 줍니다.
- **인자.** 묶음 스키마는 `action`과 각 action이 쓰는 모든 필드를 선언합니다.
  Lode가 `action`을 떼어 내고 나머지 인자로 원래 작업을 실행하므로 필수 필드는
  여전히 action마다 검사되고, 다른 action만 쓰는 필드는 무시됩니다. discovery는
  action마다 `required` 필드를 알려 줍니다.
- **결과.** 묶음 호출은 원래 작업의 결과를 그대로 반환하고, 같은 Session,
  write-guard, managed-surface 검사를 거칩니다.
- **오류.** `action`이 없거나 알 수 없는 값이면 작업을 실행하기 전에
  `INVALID_TOOL_ARGUMENTS`로 거부합니다.

## 폐기 예정 이름

묶음으로 대체된 작업 이름은 마이너 버전 두 개 동안 계속 호출할 수 있습니다.
직접 호출, `lode_tools_read` / `lode_tools_call` 경유 호출, 예전 `head_*` 표기가
모두 동작합니다. 제거 버전은 표 머리글에 적혀 있습니다.

- discovery는 묶음 도구만 나열합니다. 폐기 예정 이름으로 조회하면 그 묶음 도구를
  반환하며, `deprecatedAliases`에 옛 이름마다 `action`과 `removedIn` 버전이
  담깁니다.
- `hooks/claude.json`의 Claude Code `PreToolUse` matcher는 효과가 있거나 Session에
  묶인 action을 가진 모든 묶음 도구와, 그런 작업의 폐기 예정 이름을 포함합니다.
- 일부 작업 결과는 다음 도구를 아직 폐기 예정 이름으로 알려 줍니다. 예를 들어
  `lode_session_work_read`나 `lode_context_prepare`입니다. 이 이름은 제거 버전
  전까지 동작하므로 그대로 호출하거나, 표의 묶음 도구와 action을 사용하면 됩니다.

## 매핑

<!-- generated: mcp-surface-groups (node scripts/generate-mcp-surface-docs.mjs) -->

| 묶음 도구 | `action` | 경로 | 폐기 예정 이름 (0.5.0) |
| --- | --- | --- | --- |
| `lode_bounded_worker` | `prepare` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_prepare` |
| `lode_bounded_worker` | `start` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_start` |
| `lode_bounded_worker` | `reconcile` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_reconcile` |
| `lode_bounded_worker` | `dispatch` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_dispatch` |
| `lode_bounded_worker` | `status` | `lode_tools_read` | `lode_bounded_worker_status` |
| `lode_bounded_worker` | `wait` | `lode_tools_read` | `lode_bounded_worker_wait` |
| `lode_bounded_worker` | `apply_result` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_apply_result` |
| `lode_bounded_worker_job` | `reconcile` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_job_reconcile` |
| `lode_bounded_worker_job` | `patch` | `lode_tools_read` | `lode_bounded_worker_job_patch` |
| `lode_bounded_worker_wave` | `create` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_wave_create` |
| `lode_bounded_worker_wave` | `read` | `lode_tools_read` | `lode_bounded_worker_wave_read` |
| `lode_bounded_worker_wave` | `seal` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_wave_seal` |
| `lode_bounded_worker_wave` | `status` | `lode_tools_read` | `lode_bounded_worker_wave_status` |
| `lode_bounded_worker_wave` | `results` | `lode_tools_read` | `lode_bounded_worker_wave_results` |
| `lode_bounded_worker_wave` | `wait` | `lode_tools_read` | `lode_bounded_worker_wave_wait` |
| `lode_bounded_worker_wave` | `abandon` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_wave_abandon` |
| `lode_project_document` | `prepare` | `lode_tools_call` | `lode_project_document_prepare` |
| `lode_project_document` | `publish` | `lode_tools_call` | `lode_project_document_publish` |
| `lode_project_document` | `status` | `lode_tools_read` | `lode_project_document_status` |
| `lode_work_document` | `configure` | `lode_tools_call` | `lode_work_document_configure` |
| `lode_work_document` | `prepare` | `lode_tools_call` | `lode_work_document_prepare` |
| `lode_work_document` | `publish` | `lode_tools_call` | `lode_work_document_publish` |
| `lode_work_document` | `status` | `lode_tools_read` | `lode_work_document_status` |
| `lode_onboarding` | `guide` | `lode_tools_read` | `lode_onboarding_guide` |
| `lode_onboarding` | `semantic_refresh` | `lode_tools_call` | `lode_onboarding_semantic_refresh` |
| `lode_onboarding` | `candidate_restore` | `lode_tools_call` | `lode_onboarding_candidate_restore` |
| `lode_onboarding` | `review` | `lode_tools_call` | `lode_onboarding_review` |
| `lode_onboarding` | `status` | `lode_tools_read` | `lode_onboarding_status` |
| `lode_project_bundle` | `export` | `lode_tools_call` | `lode_project_bundle_export` |
| `lode_project_bundle` | `read` | `lode_tools_read` | `lode_project_bundle_read` |
| `lode_project_bundle` | `import` | `lode_tools_call` | `lode_project_bundle_import` |
| `lode_product` | `signal_record` | `lode_tools_call` | `lode_product_signal_record` |
| `lode_product` | `hypothesis_record` | `lode_tools_call` | `lode_product_hypothesis_record` |
| `lode_product` | `initiative_propose` | `lode_tools_call` | `lode_product_initiative_propose` |
| `lode_product` | `initiative_review` | `lode_tools_call` | `lode_product_initiative_review` |
| `lode_product` | `outcome_observe` | `lode_tools_call` | `lode_product_outcome_observe` |
| `lode_product` | `operating_status` | `lode_tools_read` | `lode_product_operating_status` |
| `lode_product` | `policy_propose` | `lode_tools_call` | `lode_product_policy_propose` |
| `lode_product` | `policy_review` | `lode_tools_call` | `lode_product_policy_review` |
| `lode_product` | `policy_status` | `lode_tools_read` | `lode_product_policy_status` |
| `lode_product` | `policy_candidate` | `lode_tools_read` | `lode_product_policy_candidate` |
| `lode_product` | `policy_review_decision` | `lode_tools_read` | `lode_product_policy_review_decision` |
| `lode_metric` | `define` | `lode_tools_call` | `lode_metric_define` |
| `lode_metric` | `observe` | `lode_tools_call` | `lode_metric_observe` |
| `lode_metric` | `compare` | `lode_tools_call` | `lode_metric_compare` |
| `lode_metric` | `assess` | `lode_tools_call` | `lode_metric_assess` |
| `lode_metric` | `status` | `lode_tools_read` | `lode_metric_status` |
| `lode_metric` | `trace` | `lode_tools_read` | `lode_metric_trace` |
| `lode_delivery` | `observe` | `lode_tools_call` | `lode_delivery_observe` |
| `lode_delivery` | `status` | `lode_tools_read` | `lode_delivery_status` |
| `lode_delivery` | `release_observe` | `lode_tools_call` | `lode_release_observe` |
| `lode_delivery` | `release_status` | `lode_tools_read` | `lode_release_status` |
| `lode_runtime` | `adapters` | `lode_tools_read` | `lode_runtime_adapters` |
| `lode_runtime` | `invocation_authorization` | `lode_tools_read` | `lode_runtime_invocation_authorization` |
| `lode_runtime` | `invocation_result` | `lode_tools_read` | `lode_runtime_invocation_result` |
| `lode_runtime` | `state` | `lode_tools_read` | `lode_runtime_state` |
| `lode_feature_mapping` | `propose` | `lode_tools_call` | `lode_feature_mapping_propose` |
| `lode_feature_mapping` | `status` | `lode_tools_read` | `lode_feature_mapping_status` |
| `lode_feature_mapping` | `review` | `lode_tools_call` | `lode_feature_mapping_review` |
| `lode_vcs` | `change_set_status` | `lode_tools_read` | `lode_change_set_status` |
| `lode_vcs` | `evidence` | `lode_tools_read` | `lode_vcs_evidence` |
| `lode_vcs` | `git_history` | `lode_tools_read` | `lode_git_history` |
| `lode_conformance` | `prepare` | `lode_tools_read` | `lode_conformance_prepare` |
| `lode_conformance` | `propose` | `lode_tools_call` | `lode_conformance_propose` |
| `lode_conformance` | `queue` | `lode_tools_read` | `lode_conformance_queue` |
| `lode_conformance` | `read` | `lode_tools_read` | `lode_conformance_read` |
| `lode_conformance` | `disposition` | `lode_tools_call` | `lode_conformance_disposition` |
| `lode_conformance` | `resolution_propose` | `lode_tools_call` | `lode_conformance_resolution_propose` |
| `lode_conformance` | `trigger_status` | `lode_tools_read` | `lode_conformance_trigger_status` |
| `lode_conformance` | `trigger_prepare` | `lode_tools_call` | `lode_conformance_trigger_prepare` |
| `lode_source` | `context` | `lode_tools_call` | `lode_source_context` |
| `lode_source` | `observation_read` | `lode_tools_read` | `lode_source_observation_read` |
| `lode_context` | `prepare` | `lode_tools_read` | `lode_context_prepare` |
| `lode_context` | `preview` | `lode_tools_read` | `lode_context_preview` |
| `lode_context` | `capsule` | `lode_tools_read` | `lode_context_capsule` |
| `lode_session` | `work_record` | `lode_tools_call` | `lode_session_work_record` |
| `lode_session` | `work_read` | `lode_tools_read` | `lode_session_work_read` |
| `lode_session` | `continue` | `lode_tools_call` | `lode_session_continue` |
| `lode_run` | `integrate_checkpoint` | `lode_tools_call` | `lode_run_integrate_checkpoint` |
| `lode_run` | `integration` | `lode_tools_read` | `lode_run_integration` |
| `lode_run` | `start` | `lode_tools_call` | `lode_run_start` |
| `lode_world` | `model` | `lode_tools_read` | `lode_world_model` |
| `lode_world` | `query` | `lode_tools_read` | `lode_world_query` |
| `lode_projection` | `incremental_refresh_status` | `lode_tools_read` | `lode_incremental_refresh_status` |
| `lode_projection` | `incremental_refresh_receipt` | `lode_tools_read` | `lode_incremental_refresh_receipt` |
| `lode_projection` | `refresh_trigger_status` | `lode_tools_read` | `lode_refresh_trigger_status` |
| `lode_projection` | `refresh_trigger_delivery` | `lode_tools_read` | `lode_refresh_trigger_delivery` |
| `lode_projection` | `graph_projection_status` | `lode_tools_read` | `lode_graph_projection_status` |
| `lode_projection` | `graphdb_projection_status` | `lode_tools_read` | `lode_graphdb_projection_status` |
| `lode_projection` | `graphdb_database_status` | `lode_tools_read` | `lode_graphdb_database_status` |
| `lode_projection` | `graphdb_connection_preflight` | `lode_tools_read` | `lode_graphdb_connection_preflight` |
| `lode_projection` | `graphdb_database_initialize` | `lode_tools_call` | `lode_graphdb_database_initialize` |
| `lode_projection` | `graphdb_projection_activate` | `lode_tools_call` | `lode_graphdb_projection_activate` |
| `lode_projection` | `markdown_projection_build` | `lode_tools_call` | `lode_markdown_projection_build` |
| `lode_projection` | `markdown_projection_status` | `lode_tools_read` | `lode_markdown_projection_status` |
| `lode_projection` | `post_refresh_projection_status` | `lode_tools_read` | `lode_post_refresh_projection_status` |
| `lode_projection` | `post_refresh_projection_receipt` | `lode_tools_read` | `lode_post_refresh_projection_receipt` |
| `lode_document_change` | `candidates` | `lode_tools_read` | `lode_document_change_candidates` |
| `lode_document_change` | `review_status` | `lode_tools_read` | `lode_document_change_review_status` |
| `lode_document_change` | `review` | `lode_tools_read` | `lode_document_change_review` |
| `lode_document_change` | `application` | `lode_tools_read` | `lode_document_change_application` |
| `lode_graph_lineage` | `status` | `lode_tools_read` | `lode_graph_lineage_status` |
| `lode_graph_lineage` | `trace` | `lode_tools_read` | `lode_graph_lineage_trace` |
| `lode_graph_lineage` | `diff` | `lode_tools_read` | `lode_graph_lineage_diff` |
| `lode_compact` | `prepare` | `lode_tools_call` | `lode_compact_prepare` |
| `lode_compact` | `verify` | `lode_tools_call` | `lode_compact_verify` |
| `lode_compact` | `continue` | `lode_tools_call` | `lode_compact_continue` |
| `lode_compact` | `status` | `lode_tools_read` | `lode_compact_status` |
| `lode_compact` | `abort` | `lode_tools_call` | `lode_compact_abort` |
| `lode_compact` | `compaction_lifecycle_step` | `lode_tools_call` | `lode_compaction_lifecycle_step` |
| `lode_observation` | `sources` | `lode_tools_read` | `lode_observation_sources` |
| `lode_observation` | `prepare` | `lode_tools_read` | `lode_observation_prepare` |
| `lode_observation` | `collect_source` | `lode_tools_call` | `lode_observation_collect_source` |
| `lode_observation` | `ingest` | `lode_tools_call` | `lode_observation_ingest` |
| `lode_observation` | `derive` | `lode_tools_call` | `lode_observation_derive` |
| `lode_observation` | `read` | `lode_tools_read` | `lode_observation_read` |
| `lode_observation` | `query` | `lode_tools_read` | `lode_observation_query` |

<!-- end generated: mcp-surface-groups -->

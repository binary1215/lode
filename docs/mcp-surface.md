# MCP tool surface and deprecated names

Lode lists a small default set of MCP tools and makes every other operation
available through discovery and the two routers. Since 0.3, operations on the same
resource are grouped into one tool that takes an `action`.

## Default list

The ordinary `tools/list` has 22 tools. It includes `lode_tools_discover`,
`lode_tools_read` and `lode_tools_call`. Grouping does not change it; grouping
changes only what discovery and the managed maintenance `tools/list` show.

The native Claude Hook helper `lode_session_host_request_prepare` is not a
catalog tool. No `tools/list`, discovery or router shows or routes it; only the
bundled PreToolUse Hook calls it. Earlier versions listed it as a 23rd tool.

## Grouped tools

A grouped tool is named after its resource, for example
`lode_bounded_worker_wave`. Its `action` selects exactly one existing operation:

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

- **Routes.** Each action keeps its operation's route. Read-only actions go
  through `lode_tools_read`; `lode_tools_read` refuses an action that is not
  read-only. Discovery returns `actions`, with each action's `invokeWith`,
  required fields and `executionMode`.
- **Managed actions.** An action whose operation is a managed mutation, such as
  `seal` above, needs `execution_mode: "managed"` on `lode_tools_call`, exactly
  like the operation it selects. Without it the ordinary surface refuses it with
  `MANAGED_OPERATION_NOT_ON_DEFAULT_SURFACE`. The table marks these actions, and
  discovery reports them with `executionMode: "managed"`.
- **Arguments.** The grouped schema declares `action` and every field its actions
  use. Each action still checks its own required and optional fields: Lode
  removes `action` and runs the operation with the remaining arguments.
- **Results.** A grouped call returns exactly what the operation returns, and it
  runs the same Session, write-guard and managed-surface checks.
- **Errors.** A missing or unknown `action` is refused with
  `INVALID_TOOL_ARGUMENTS` before any operation runs.

## Deprecated names

The operation names a group replaced remain callable for two minor versions:
directly, through `lode_tools_read` / `lode_tools_call`, and in their historical
`head_*` spelling. They are removed in the version named in the table header.

- Discovery lists only the grouped tool. Looking up a deprecated name returns that
  grouped tool, whose `deprecatedAliases` lists each old name with its `action`
  and `removedIn` version.
- The Claude Code `PreToolUse` matchers in `hooks/claude.json` cover both the
  grouped tools and the deprecated names.

## Mapping

<!-- generated: mcp-surface-groups (node scripts/generate-mcp-surface-docs.mjs) -->

| Grouped tool | `action` | Route | Deprecated name (0.5.0) |
| --- | --- | --- | --- |
| `lode_bounded_worker` | `prepare` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_prepare` |
| `lode_bounded_worker` | `start` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_start` |
| `lode_bounded_worker` | `reconcile` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_reconcile` |
| `lode_bounded_worker` | `dispatch` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_dispatch` |
| `lode_bounded_worker` | `status` | `lode_tools_read` | `lode_bounded_worker_status` |
| `lode_bounded_worker` | `wait` | `lode_tools_read` | `lode_bounded_worker_wait` |
| `lode_bounded_worker` | `apply_result` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_apply_result` |
| `lode_bounded_worker_job` | `reconcile` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_job_reconcile` |
| `lode_bounded_worker_job` | `patch` | `lode_tools_read` | `lode_bounded_worker_job_patch` |
| `lode_bounded_worker_wave` | `create` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_wave_create` |
| `lode_bounded_worker_wave` | `read` | `lode_tools_read` | `lode_bounded_worker_wave_read` |
| `lode_bounded_worker_wave` | `seal` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_wave_seal` |
| `lode_bounded_worker_wave` | `status` | `lode_tools_read` | `lode_bounded_worker_wave_status` |
| `lode_bounded_worker_wave` | `results` | `lode_tools_read` | `lode_bounded_worker_wave_results` |
| `lode_bounded_worker_wave` | `wait` | `lode_tools_read` | `lode_bounded_worker_wave_wait` |
| `lode_bounded_worker_wave` | `abandon` | `lode_tools_call` with `execution_mode: managed` | `lode_bounded_worker_wave_abandon` |
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

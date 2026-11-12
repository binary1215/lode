// One-way compatibility for operation names: a historical head_<suffix> wire
// name means lode_<suffix>. Only names whose canonical form is a registered
// operation resolve (see scripts/lib/core/lode-operation-contract.mjs).
export const LEGACY_OPERATION_PREFIX = "head_";
export const OPERATION_PREFIX = "lode_";

export function canonicalOperationName(name) {
  return typeof name === "string" && name.startsWith(LEGACY_OPERATION_PREFIX) ? OPERATION_PREFIX + name.slice(LEGACY_OPERATION_PREFIX.length) : name;
}

// The historical spelling, still presented by the head-agent carrier package.
export function legacyOperationName(canonicalName) {
  if (typeof canonicalName !== "string" || !canonicalName.startsWith(OPERATION_PREFIX)) throw new Error(`Not a canonical operation name: ${canonicalName}`);
  return LEGACY_OPERATION_PREFIX + canonicalName.slice(OPERATION_PREFIX.length);
}

export const ENVIRONMENT_NAME_PAIRS = Object.freeze(
  [
    {
      canonical: "LODE_PYTHON",
      legacy: "HEAD_PYTHON",
      class: "trusted-path-domain",
    },
    {
      canonical: "LODE_AGENT_ARCADEDB_NATIVE_MODE",
      legacy: "HEAD_AGENT_ARCADEDB_NATIVE_MODE",
      class: "ordinary-or-test-setting",
    },
    {
      canonical: "LODE_AGENT_BIN_DIR",
      legacy: "HEAD_AGENT_BIN_DIR",
      class: "trusted-path-domain",
    },
    {
      canonical: "LODE_AGENT_CODEX_INSTALLED_POLICY_EXECUTABLE",
      legacy: "HEAD_AGENT_CODEX_INSTALLED_POLICY_EXECUTABLE",
      class: "test-harness-target-identity",
    },
    {
      canonical: "LODE_AGENT_CODEX_INSTALLED_POLICY_EXEC_HELP",
      legacy: "HEAD_AGENT_CODEX_INSTALLED_POLICY_EXEC_HELP",
      class: "ordinary-or-test-setting",
    },
    {
      canonical: "LODE_AGENT_CODEX_INSTALLED_POLICY_SCHEMA_DIRECTORY",
      legacy: "HEAD_AGENT_CODEX_INSTALLED_POLICY_SCHEMA_DIRECTORY",
      class: "test-harness-target-identity",
    },
    {
      canonical: "LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT",
      legacy: "HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT",
      class: "test-harness-target-identity",
    },
    {
      canonical: "LODE_AGENT_GO_WORKER_FIXTURE_ROOT",
      legacy: "HEAD_AGENT_GO_WORKER_FIXTURE_ROOT",
      class: "test-harness-target-identity",
    },
    {
      canonical: "LODE_AGENT_HOST_ENDPOINT_ID",
      legacy: "HEAD_AGENT_HOST_ENDPOINT_ID",
      class: "exact-trusted-identity",
    },
    {
      canonical: "LODE_AGENT_HOST_PROCESS_PROOF",
      legacy: "HEAD_AGENT_HOST_PROCESS_PROOF",
      class: "exact-trusted-identity",
    },
    {
      canonical: "LODE_AGENT_HOST_PROJECT_ROOT",
      legacy: "HEAD_AGENT_HOST_PROJECT_ROOT",
      class: "trusted-path-domain",
    },
    {
      canonical: "LODE_AGENT_HOST_TAB_ID",
      legacy: "HEAD_AGENT_HOST_TAB_ID",
      class: "exact-trusted-identity",
    },
    {
      canonical: "LODE_AGENT_HOST_WORKSPACE_ID",
      legacy: "HEAD_AGENT_HOST_WORKSPACE_ID",
      class: "exact-trusted-identity",
    },
    {
      canonical: "LODE_AGENT_INBOX_REPLY",
      legacy: "HEAD_AGENT_INBOX_REPLY",
      class: "ordinary-or-test-setting",
    },
    {
      canonical: "LODE_AGENT_INSTALL_ROOT",
      legacy: "HEAD_AGENT_INSTALL_ROOT",
      class: "trusted-path-domain",
    },
    {
      canonical: "LODE_AGENT_KEEP_TEST_TMP",
      legacy: "HEAD_AGENT_KEEP_TEST_TMP",
      class: "ordinary-or-test-setting",
    },
    {
      canonical: "LODE_AGENT_LIVE_CODEX_E2E",
      legacy: "HEAD_AGENT_LIVE_CODEX_E2E",
      class: "existing-opt-in-external-effect",
    },
    {
      canonical: "LODE_AGENT_LIVE_CODEX_E2E_MODE",
      legacy: "HEAD_AGENT_LIVE_CODEX_E2E_MODE",
      class: "existing-opt-in-external-effect",
    },
    {
      canonical: "LODE_AGENT_LIVE_RUNTIME",
      legacy: "HEAD_AGENT_LIVE_RUNTIME",
      class: "existing-opt-in-external-effect",
    },
    {
      canonical: "LODE_AGENT_LIVE_RUNTIME_E2E",
      legacy: "HEAD_AGENT_LIVE_RUNTIME_E2E",
      class: "existing-opt-in-external-effect",
    },
    {
      canonical: "LODE_AGENT_LIVE_RUNTIME_E2E_MODE",
      legacy: "HEAD_AGENT_LIVE_RUNTIME_E2E_MODE",
      class: "existing-opt-in-external-effect",
    },
    {
      canonical: "LODE_AGENT_LIVE_RUNTIME_MODEL",
      legacy: "HEAD_AGENT_LIVE_RUNTIME_MODEL",
      class: "existing-opt-in-external-effect",
    },
    {
      canonical: "LODE_AGENT_OPERATIONAL_STATE_ROOT",
      legacy: "HEAD_AGENT_OPERATIONAL_STATE_ROOT",
      class: "trusted-path-domain",
    },
    {
      canonical: "LODE_AGENT_PREFIX_CAPTURE_EXECUTABLE",
      legacy: "HEAD_AGENT_PREFIX_CAPTURE_EXECUTABLE",
      class: "test-harness-target-identity",
    },
    {
      canonical: "LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT",
      legacy: "HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT",
      class: "test-harness-target-identity",
    },
    {
      canonical: "LODE_AGENT_TEST_CODEX_BIN",
      legacy: "HEAD_AGENT_TEST_CODEX_BIN",
      class: "test-harness-target-identity",
    },
    {
      canonical: "LODE_AGENT_TEST_CODEX_HOST_DISCOVERY",
      legacy: "HEAD_AGENT_TEST_CODEX_HOST_DISCOVERY",
      class: "existing-opt-in-external-effect",
    },
    {
      canonical: "LODE_AGENT_TEST_OWNER_CRASH_FIXTURE",
      legacy: "HEAD_AGENT_TEST_OWNER_CRASH_FIXTURE",
      class: "test-harness-target-identity",
    },
    {
      canonical: "LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT",
      legacy: "HEAD_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT",
      class: "test-harness-target-identity",
    },
    {
      canonical: "LODE_AGENT_TEST_TMP",
      legacy: "HEAD_AGENT_TEST_TMP",
      class: "ordinary-or-test-setting",
    },
    {
      canonical: "LODE_AGENT_WORKSPACE_HOST_EXPORT_ROOT",
      legacy: "HEAD_AGENT_WORKSPACE_HOST_EXPORT_ROOT",
      class: "trusted-path-domain",
    },
  ].map(Object.freeze),
);
export const DISCOVERY_PREFIX_PAIRS = Object.freeze(
  [
    {
      legacy: "head_bounded_",
      canonical: "lode_bounded_",
    },
    {
      legacy: "head_change_",
      canonical: "lode_change_",
    },
    {
      legacy: "head_checkpoint_",
      canonical: "lode_checkpoint_",
    },
    {
      legacy: "head_compact_",
      canonical: "lode_compact_",
    },
    {
      legacy: "head_compaction_",
      canonical: "lode_compaction_",
    },
    {
      legacy: "head_conformance_",
      canonical: "lode_conformance_",
    },
    {
      legacy: "head_context_",
      canonical: "lode_context_",
    },
    {
      legacy: "head_continuity_",
      canonical: "lode_continuity_",
    },
    {
      legacy: "head_conversation_",
      canonical: "lode_conversation_",
    },
    {
      legacy: "head_core_",
      canonical: "lode_core_",
    },
    {
      legacy: "head_delivery_",
      canonical: "lode_delivery_",
    },
    {
      legacy: "head_document_",
      canonical: "lode_document_",
    },
    {
      legacy: "head_feature_",
      canonical: "lode_feature_",
    },
    {
      legacy: "head_git_",
      canonical: "lode_git_",
    },
    {
      legacy: "head_graph_",
      canonical: "lode_graph_",
    },
    {
      legacy: "head_graphdb_",
      canonical: "lode_graphdb_",
    },
    {
      legacy: "head_incremental_",
      canonical: "lode_incremental_",
    },
    {
      legacy: "head_lineage_",
      canonical: "lode_lineage_",
    },
    {
      legacy: "head_markdown_",
      canonical: "lode_markdown_",
    },
    {
      legacy: "head_metric_",
      canonical: "lode_metric_",
    },
    {
      legacy: "head_observation_",
      canonical: "lode_observation_",
    },
    {
      legacy: "head_onboarding_",
      canonical: "lode_onboarding_",
    },
    {
      legacy: "head_pending_",
      canonical: "lode_pending_",
    },
    {
      legacy: "head_post_",
      canonical: "lode_post_",
    },
    {
      legacy: "head_product_",
      canonical: "lode_product_",
    },
    {
      legacy: "head_project_",
      canonical: "lode_project_",
    },
    {
      legacy: "head_refresh_",
      canonical: "lode_refresh_",
    },
    {
      legacy: "head_release_",
      canonical: "lode_release_",
    },
    {
      legacy: "head_run_",
      canonical: "lode_run_",
    },
    {
      legacy: "head_runtime_",
      canonical: "lode_runtime_",
    },
    {
      legacy: "head_session_",
      canonical: "lode_session_",
    },
    {
      legacy: "head_source_",
      canonical: "lode_source_",
    },
    {
      legacy: "head_temporal_",
      canonical: "lode_temporal_",
    },
    {
      legacy: "head_vcs_",
      canonical: "lode_vcs_",
    },
    {
      legacy: "head_worker_",
      canonical: "lode_worker_",
    },
    {
      legacy: "head_world_",
      canonical: "lode_world_",
    },
    {
      legacy: "head_work_",
      canonical: "lode_work_",
    },
  ].map(Object.freeze),
);

// Finite compatibility spellings; never rewrite arbitrary prefixes.
export const OPERATION_NAME_PAIRS = Object.freeze([
  {
    "legacyName": "head_core_contract",
    "canonicalName": "lode_core_contract",
    "semanticName": "head_core_contract",
    "suffix": "core_contract",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_project_status",
    "canonicalName": "lode_project_status",
    "semanticName": "head_project_status",
    "suffix": "project_status",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": "optional-native-status"
  },
  {
    "legacyName": "head_onboarding_guide",
    "canonicalName": "lode_onboarding_guide",
    "semanticName": "head_onboarding_guide",
    "suffix": "onboarding_guide",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_project_initialize_or_resume",
    "canonicalName": "lode_project_initialize_or_resume",
    "semanticName": "head_project_initialize_or_resume",
    "suffix": "project_initialize_or_resume",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": "select-on-confirmed-init-resume"
  },
  {
    "legacyName": "head_onboarding_semantic_refresh",
    "canonicalName": "lode_onboarding_semantic_refresh",
    "semanticName": "head_onboarding_semantic_refresh",
    "suffix": "onboarding_semantic_refresh",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_onboarding_candidate_restore",
    "canonicalName": "lode_onboarding_candidate_restore",
    "semanticName": "head_onboarding_candidate_restore",
    "suffix": "onboarding_candidate_restore",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_onboarding_review",
    "canonicalName": "lode_onboarding_review",
    "semanticName": "head_onboarding_review",
    "suffix": "onboarding_review",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_product_policy_propose",
    "canonicalName": "lode_product_policy_propose",
    "semanticName": "head_product_policy_propose",
    "suffix": "product_policy_propose",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_product_policy_review",
    "canonicalName": "lode_product_policy_review",
    "semanticName": "head_product_policy_review",
    "suffix": "product_policy_review",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_product_policy_status",
    "canonicalName": "lode_product_policy_status",
    "semanticName": "head_product_policy_status",
    "suffix": "product_policy_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_product_policy_candidate",
    "canonicalName": "lode_product_policy_candidate",
    "semanticName": "head_product_policy_candidate",
    "suffix": "product_policy_candidate",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_product_policy_review_decision",
    "canonicalName": "lode_product_policy_review_decision",
    "semanticName": "head_product_policy_review_decision",
    "suffix": "product_policy_review_decision",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_metric_define",
    "canonicalName": "lode_metric_define",
    "semanticName": "head_metric_define",
    "suffix": "metric_define",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_metric_observe",
    "canonicalName": "lode_metric_observe",
    "semanticName": "head_metric_observe",
    "suffix": "metric_observe",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_metric_compare",
    "canonicalName": "lode_metric_compare",
    "semanticName": "head_metric_compare",
    "suffix": "metric_compare",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_metric_assess",
    "canonicalName": "lode_metric_assess",
    "semanticName": "head_metric_assess",
    "suffix": "metric_assess",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_metric_status",
    "canonicalName": "lode_metric_status",
    "semanticName": "head_metric_status",
    "suffix": "metric_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_metric_trace",
    "canonicalName": "lode_metric_trace",
    "semanticName": "head_metric_trace",
    "suffix": "metric_trace",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_delivery_observe",
    "canonicalName": "lode_delivery_observe",
    "semanticName": "head_delivery_observe",
    "suffix": "delivery_observe",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_delivery_status",
    "canonicalName": "lode_delivery_status",
    "semanticName": "head_delivery_status",
    "suffix": "delivery_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_markdown_projection_build",
    "canonicalName": "lode_markdown_projection_build",
    "semanticName": "head_markdown_projection_build",
    "suffix": "markdown_projection_build",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_runtime_adapters",
    "canonicalName": "lode_runtime_adapters",
    "semanticName": "head_runtime_adapters",
    "suffix": "runtime_adapters",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_runtime_invocation_authorization",
    "canonicalName": "lode_runtime_invocation_authorization",
    "semanticName": "head_runtime_invocation_authorization",
    "suffix": "runtime_invocation_authorization",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_runtime_invocation_lease_status",
    "canonicalName": "lode_runtime_invocation_lease_status",
    "semanticName": "head_runtime_invocation_lease_status",
    "suffix": "runtime_invocation_lease_status",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_runtime_invocation_result",
    "canonicalName": "lode_runtime_invocation_result",
    "semanticName": "head_runtime_invocation_result",
    "suffix": "runtime_invocation_result",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_onboarding_status",
    "canonicalName": "lode_onboarding_status",
    "semanticName": "head_onboarding_status",
    "suffix": "onboarding_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_feature_mapping_propose",
    "canonicalName": "lode_feature_mapping_propose",
    "semanticName": "head_feature_mapping_propose",
    "suffix": "feature_mapping_propose",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_feature_mapping_status",
    "canonicalName": "lode_feature_mapping_status",
    "semanticName": "head_feature_mapping_status",
    "suffix": "feature_mapping_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_feature_mapping_review",
    "canonicalName": "lode_feature_mapping_review",
    "semanticName": "head_feature_mapping_review",
    "suffix": "feature_mapping_review",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_change_set_status",
    "canonicalName": "lode_change_set_status",
    "semanticName": "head_change_set_status",
    "suffix": "change_set_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_vcs_evidence",
    "canonicalName": "lode_vcs_evidence",
    "semanticName": "head_vcs_evidence",
    "suffix": "vcs_evidence",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_conformance_prepare",
    "canonicalName": "lode_conformance_prepare",
    "semanticName": "head_conformance_prepare",
    "suffix": "conformance_prepare",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_conformance_propose",
    "canonicalName": "lode_conformance_propose",
    "semanticName": "head_conformance_propose",
    "suffix": "conformance_propose",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_conformance_queue",
    "canonicalName": "lode_conformance_queue",
    "semanticName": "head_conformance_queue",
    "suffix": "conformance_queue",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_conformance_read",
    "canonicalName": "lode_conformance_read",
    "semanticName": "head_conformance_read",
    "suffix": "conformance_read",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_conformance_disposition",
    "canonicalName": "lode_conformance_disposition",
    "semanticName": "head_conformance_disposition",
    "suffix": "conformance_disposition",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_conformance_resolution_propose",
    "canonicalName": "lode_conformance_resolution_propose",
    "semanticName": "head_conformance_resolution_propose",
    "suffix": "conformance_resolution_propose",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_conformance_trigger_status",
    "canonicalName": "lode_conformance_trigger_status",
    "semanticName": "head_conformance_trigger_status",
    "suffix": "conformance_trigger_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_conformance_trigger_prepare",
    "canonicalName": "lode_conformance_trigger_prepare",
    "semanticName": "head_conformance_trigger_prepare",
    "suffix": "conformance_trigger_prepare",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_source_context",
    "canonicalName": "lode_source_context",
    "semanticName": "head_source_context",
    "suffix": "source_context",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": "abortable-source-request"
  },
  {
    "legacyName": "head_source_observation_read",
    "canonicalName": "lode_source_observation_read",
    "semanticName": "head_source_observation_read",
    "suffix": "source_observation_read",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_context_prepare",
    "canonicalName": "lode_context_prepare",
    "semanticName": "head_context_prepare",
    "suffix": "context_prepare",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_context_preview",
    "canonicalName": "lode_context_preview",
    "semanticName": "head_context_preview",
    "suffix": "context_preview",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_context_capsule",
    "canonicalName": "lode_context_capsule",
    "semanticName": "head_context_capsule",
    "suffix": "context_capsule",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_lineage_artifact",
    "canonicalName": "lode_lineage_artifact",
    "semanticName": "head_lineage_artifact",
    "suffix": "lineage_artifact",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_pending_review",
    "canonicalName": "lode_pending_review",
    "semanticName": "head_pending_review",
    "suffix": "pending_review",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_checkpoint_basis",
    "canonicalName": "lode_checkpoint_basis",
    "semanticName": "head_checkpoint_basis",
    "suffix": "checkpoint_basis",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_checkpoint_diagnose",
    "canonicalName": "lode_checkpoint_diagnose",
    "semanticName": "head_checkpoint_diagnose",
    "suffix": "checkpoint_diagnose",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_checkpoint_sync",
    "canonicalName": "lode_checkpoint_sync",
    "semanticName": "head_checkpoint_sync",
    "suffix": "checkpoint_sync",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_session_work_record",
    "canonicalName": "lode_session_work_record",
    "semanticName": "head_session_work_record",
    "suffix": "session_work_record",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_session_work_read",
    "canonicalName": "lode_session_work_read",
    "semanticName": "head_session_work_read",
    "suffix": "session_work_read",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_session_restore",
    "canonicalName": "lode_session_restore",
    "semanticName": "head_session_restore",
    "suffix": "session_restore",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_session_continue",
    "canonicalName": "lode_session_continue",
    "semanticName": "head_session_continue",
    "suffix": "session_continue",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_worker_integration",
    "canonicalName": "lode_worker_integration",
    "semanticName": "head_worker_integration",
    "suffix": "worker_integration",
    "router": false,
    "sessionDependent": true,
    "managedMutation": true,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_worker_integration_status",
    "canonicalName": "lode_worker_integration_status",
    "semanticName": "head_worker_integration_status",
    "suffix": "worker_integration_status",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_prepare",
    "canonicalName": "lode_bounded_worker_prepare",
    "semanticName": "head_bounded_worker_prepare",
    "suffix": "bounded_worker_prepare",
    "router": false,
    "sessionDependent": true,
    "managedMutation": true,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_start",
    "canonicalName": "lode_bounded_worker_start",
    "semanticName": "head_bounded_worker_start",
    "suffix": "bounded_worker_start",
    "router": false,
    "sessionDependent": true,
    "managedMutation": true,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_reconcile",
    "canonicalName": "lode_bounded_worker_reconcile",
    "semanticName": "head_bounded_worker_reconcile",
    "suffix": "bounded_worker_reconcile",
    "router": false,
    "sessionDependent": true,
    "managedMutation": true,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_dispatch",
    "canonicalName": "lode_bounded_worker_dispatch",
    "semanticName": "head_bounded_worker_dispatch",
    "suffix": "bounded_worker_dispatch",
    "router": false,
    "sessionDependent": true,
    "managedMutation": true,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_status",
    "canonicalName": "lode_bounded_worker_status",
    "semanticName": "head_bounded_worker_status",
    "suffix": "bounded_worker_status",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_wait",
    "canonicalName": "lode_bounded_worker_wait",
    "semanticName": "head_bounded_worker_wait",
    "suffix": "bounded_worker_wait",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_apply_result",
    "canonicalName": "lode_bounded_worker_apply_result",
    "semanticName": "head_bounded_worker_apply_result",
    "suffix": "bounded_worker_apply_result",
    "router": false,
    "sessionDependent": true,
    "managedMutation": true,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_wave_create",
    "canonicalName": "lode_bounded_worker_wave_create",
    "semanticName": "head_bounded_worker_wave_create",
    "suffix": "bounded_worker_wave_create",
    "router": false,
    "sessionDependent": true,
    "managedMutation": true,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_wave_read",
    "canonicalName": "lode_bounded_worker_wave_read",
    "semanticName": "head_bounded_worker_wave_read",
    "suffix": "bounded_worker_wave_read",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_wave_seal",
    "canonicalName": "lode_bounded_worker_wave_seal",
    "semanticName": "head_bounded_worker_wave_seal",
    "suffix": "bounded_worker_wave_seal",
    "router": false,
    "sessionDependent": true,
    "managedMutation": true,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_wave_status",
    "canonicalName": "lode_bounded_worker_wave_status",
    "semanticName": "head_bounded_worker_wave_status",
    "suffix": "bounded_worker_wave_status",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_wave_results",
    "canonicalName": "lode_bounded_worker_wave_results",
    "semanticName": "head_bounded_worker_wave_results",
    "suffix": "bounded_worker_wave_results",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_wave_wait",
    "canonicalName": "lode_bounded_worker_wave_wait",
    "semanticName": "head_bounded_worker_wave_wait",
    "suffix": "bounded_worker_wave_wait",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_wave_abandon",
    "canonicalName": "lode_bounded_worker_wave_abandon",
    "semanticName": "head_bounded_worker_wave_abandon",
    "suffix": "bounded_worker_wave_abandon",
    "router": false,
    "sessionDependent": true,
    "managedMutation": true,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_run_integrate_checkpoint",
    "canonicalName": "lode_run_integrate_checkpoint",
    "semanticName": "head_run_integrate_checkpoint",
    "suffix": "run_integrate_checkpoint",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_run_integration",
    "canonicalName": "lode_run_integration",
    "semanticName": "head_run_integration",
    "suffix": "run_integration",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_world_model",
    "canonicalName": "lode_world_model",
    "semanticName": "head_world_model",
    "suffix": "world_model",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_incremental_refresh_status",
    "canonicalName": "lode_incremental_refresh_status",
    "semanticName": "head_incremental_refresh_status",
    "suffix": "incremental_refresh_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_incremental_refresh_receipt",
    "canonicalName": "lode_incremental_refresh_receipt",
    "semanticName": "head_incremental_refresh_receipt",
    "suffix": "incremental_refresh_receipt",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_refresh_trigger_status",
    "canonicalName": "lode_refresh_trigger_status",
    "semanticName": "head_refresh_trigger_status",
    "suffix": "refresh_trigger_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_refresh_trigger_delivery",
    "canonicalName": "lode_refresh_trigger_delivery",
    "semanticName": "head_refresh_trigger_delivery",
    "suffix": "refresh_trigger_delivery",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_graph_projection_status",
    "canonicalName": "lode_graph_projection_status",
    "semanticName": "head_graph_projection_status",
    "suffix": "graph_projection_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_graphdb_projection_status",
    "canonicalName": "lode_graphdb_projection_status",
    "semanticName": "head_graphdb_projection_status",
    "suffix": "graphdb_projection_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_graphdb_database_status",
    "canonicalName": "lode_graphdb_database_status",
    "semanticName": "head_graphdb_database_status",
    "suffix": "graphdb_database_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_graphdb_connection_preflight",
    "canonicalName": "lode_graphdb_connection_preflight",
    "semanticName": "head_graphdb_connection_preflight",
    "suffix": "graphdb_connection_preflight",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_graphdb_database_initialize",
    "canonicalName": "lode_graphdb_database_initialize",
    "semanticName": "head_graphdb_database_initialize",
    "suffix": "graphdb_database_initialize",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_graphdb_projection_activate",
    "canonicalName": "lode_graphdb_projection_activate",
    "semanticName": "head_graphdb_projection_activate",
    "suffix": "graphdb_projection_activate",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_markdown_projection_status",
    "canonicalName": "lode_markdown_projection_status",
    "semanticName": "head_markdown_projection_status",
    "suffix": "markdown_projection_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_post_refresh_projection_status",
    "canonicalName": "lode_post_refresh_projection_status",
    "semanticName": "head_post_refresh_projection_status",
    "suffix": "post_refresh_projection_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_post_refresh_projection_receipt",
    "canonicalName": "lode_post_refresh_projection_receipt",
    "semanticName": "head_post_refresh_projection_receipt",
    "suffix": "post_refresh_projection_receipt",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_document_change_candidates",
    "canonicalName": "lode_document_change_candidates",
    "semanticName": "head_document_change_candidates",
    "suffix": "document_change_candidates",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_document_change_review_status",
    "canonicalName": "lode_document_change_review_status",
    "semanticName": "head_document_change_review_status",
    "suffix": "document_change_review_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_document_change_review",
    "canonicalName": "lode_document_change_review",
    "semanticName": "head_document_change_review",
    "suffix": "document_change_review",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_document_change_application",
    "canonicalName": "lode_document_change_application",
    "semanticName": "head_document_change_application",
    "suffix": "document_change_application",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_world_query",
    "canonicalName": "lode_world_query",
    "semanticName": "head_world_query",
    "suffix": "world_query",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_git_history",
    "canonicalName": "lode_git_history",
    "semanticName": "head_git_history",
    "suffix": "git_history",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_temporal_graph",
    "canonicalName": "lode_temporal_graph",
    "semanticName": "head_temporal_graph",
    "suffix": "temporal_graph",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_graph_lineage_status",
    "canonicalName": "lode_graph_lineage_status",
    "semanticName": "head_graph_lineage_status",
    "suffix": "graph_lineage_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_graph_lineage_trace",
    "canonicalName": "lode_graph_lineage_trace",
    "semanticName": "head_graph_lineage_trace",
    "suffix": "graph_lineage_trace",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_graph_lineage_diff",
    "canonicalName": "lode_graph_lineage_diff",
    "semanticName": "head_graph_lineage_diff",
    "suffix": "graph_lineage_diff",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_runtime_state",
    "canonicalName": "lode_runtime_state",
    "semanticName": "head_runtime_state",
    "suffix": "runtime_state",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_compact_prepare",
    "canonicalName": "lode_compact_prepare",
    "semanticName": "head_compact_prepare",
    "suffix": "compact_prepare",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_compact_verify",
    "canonicalName": "lode_compact_verify",
    "semanticName": "head_compact_verify",
    "suffix": "compact_verify",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_compact_continue",
    "canonicalName": "lode_compact_continue",
    "semanticName": "head_compact_continue",
    "suffix": "compact_continue",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_compact_status",
    "canonicalName": "lode_compact_status",
    "semanticName": "head_compact_status",
    "suffix": "compact_status",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_compact_abort",
    "canonicalName": "lode_compact_abort",
    "semanticName": "head_compact_abort",
    "suffix": "compact_abort",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_product_signal_record",
    "canonicalName": "lode_product_signal_record",
    "semanticName": "head_product_signal_record",
    "suffix": "product_signal_record",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_product_hypothesis_record",
    "canonicalName": "lode_product_hypothesis_record",
    "semanticName": "head_product_hypothesis_record",
    "suffix": "product_hypothesis_record",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_product_initiative_propose",
    "canonicalName": "lode_product_initiative_propose",
    "semanticName": "head_product_initiative_propose",
    "suffix": "product_initiative_propose",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_product_initiative_review",
    "canonicalName": "lode_product_initiative_review",
    "semanticName": "head_product_initiative_review",
    "suffix": "product_initiative_review",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_product_outcome_observe",
    "canonicalName": "lode_product_outcome_observe",
    "semanticName": "head_product_outcome_observe",
    "suffix": "product_outcome_observe",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_product_operating_status",
    "canonicalName": "lode_product_operating_status",
    "semanticName": "head_product_operating_status",
    "suffix": "product_operating_status",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_release_observe",
    "canonicalName": "lode_release_observe",
    "semanticName": "head_release_observe",
    "suffix": "release_observe",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_release_status",
    "canonicalName": "lode_release_status",
    "semanticName": "head_release_status",
    "suffix": "release_status",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_observation_sources",
    "canonicalName": "lode_observation_sources",
    "semanticName": "head_observation_sources",
    "suffix": "observation_sources",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_observation_prepare",
    "canonicalName": "lode_observation_prepare",
    "semanticName": "head_observation_prepare",
    "suffix": "observation_prepare",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_observation_collect_source",
    "canonicalName": "lode_observation_collect_source",
    "semanticName": "head_observation_collect_source",
    "suffix": "observation_collect_source",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_observation_ingest",
    "canonicalName": "lode_observation_ingest",
    "semanticName": "head_observation_ingest",
    "suffix": "observation_ingest",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_observation_derive",
    "canonicalName": "lode_observation_derive",
    "semanticName": "head_observation_derive",
    "suffix": "observation_derive",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_conversation_enter",
    "canonicalName": "lode_conversation_enter",
    "semanticName": "head_conversation_enter",
    "suffix": "conversation_enter",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": "optional-related-native-context"
  },
  {
    "legacyName": "head_compaction_lifecycle_step",
    "canonicalName": "lode_compaction_lifecycle_step",
    "semanticName": "head_compaction_lifecycle_step",
    "suffix": "compaction_lifecycle_step",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_observation_read",
    "canonicalName": "lode_observation_read",
    "semanticName": "head_observation_read",
    "suffix": "observation_read",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_observation_query",
    "canonicalName": "lode_observation_query",
    "semanticName": "head_observation_query",
    "suffix": "observation_query",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_continuity_snapshot",
    "canonicalName": "lode_continuity_snapshot",
    "semanticName": "head_continuity_snapshot",
    "suffix": "continuity_snapshot",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_project_graph",
    "canonicalName": "lode_project_graph",
    "semanticName": "head_project_graph",
    "suffix": "project_graph",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_project_graph_index",
    "canonicalName": "lode_project_graph_index",
    "semanticName": "head_project_graph_index",
    "suffix": "project_graph_index",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_session_create",
    "canonicalName": "lode_session_create",
    "semanticName": "head_session_create",
    "suffix": "session_create",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_session_list",
    "canonicalName": "lode_session_list",
    "semanticName": "head_session_list",
    "suffix": "session_list",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_project_direction_read",
    "canonicalName": "lode_project_direction_read",
    "semanticName": "head_project_direction_read",
    "suffix": "project_direction_read",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_project_direction_update",
    "canonicalName": "lode_project_direction_update",
    "semanticName": "head_project_direction_update",
    "suffix": "project_direction_update",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_run_start",
    "canonicalName": "lode_run_start",
    "semanticName": "head_run_start",
    "suffix": "run_start",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_job_status",
    "canonicalName": "lode_bounded_worker_job_status",
    "semanticName": "head_bounded_worker_job_status",
    "suffix": "bounded_worker_job_status",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_job_reconcile",
    "canonicalName": "lode_bounded_worker_job_reconcile",
    "semanticName": "head_bounded_worker_job_reconcile",
    "suffix": "bounded_worker_job_reconcile",
    "router": false,
    "sessionDependent": true,
    "managedMutation": true,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_cancel",
    "canonicalName": "lode_bounded_worker_cancel",
    "semanticName": "head_bounded_worker_cancel",
    "suffix": "bounded_worker_cancel",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_bounded_worker_job_patch",
    "canonicalName": "lode_bounded_worker_job_patch",
    "semanticName": "head_bounded_worker_job_patch",
    "suffix": "bounded_worker_job_patch",
    "router": false,
    "sessionDependent": true,
    "managedMutation": false,
    "kind": "operation",
    "nativeRole": null
  },
  {
    "legacyName": "head_session_host_request_prepare",
    "canonicalName": "lode_session_host_request_prepare",
    "semanticName": "head_session_host_request_prepare",
    "suffix": "session_host_request_prepare",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "private-hook-helper",
    "nativeRole": null
  },
  {
    "legacyName": "head_tools_discover",
    "canonicalName": "lode_tools_discover",
    "semanticName": "head_tools_discover",
    "suffix": "tools_discover",
    "router": false,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "discovery",
    "nativeRole": null
  },
  {
    "legacyName": "head_tools_read",
    "canonicalName": "lode_tools_read",
    "semanticName": "head_tools_read",
    "suffix": "tools_read",
    "router": true,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "router",
    "nativeRole": null
  },
  {
    "legacyName": "head_tools_call",
    "canonicalName": "lode_tools_call",
    "semanticName": "head_tools_call",
    "suffix": "tools_call",
    "router": true,
    "sessionDependent": false,
    "managedMutation": false,
    "kind": "router",
    "nativeRole": null
  }
].map(Object.freeze));
export const ENVIRONMENT_NAME_PAIRS = Object.freeze([
  {
    "canonical": "LODE_PYTHON",
    "legacy": "HEAD_PYTHON",
    "class": "trusted-path-domain"
  },
  {
    "canonical": "LODE_AGENT_ARCADEDB_NATIVE_MODE",
    "legacy": "HEAD_AGENT_ARCADEDB_NATIVE_MODE",
    "class": "ordinary-or-test-setting"
  },
  {
    "canonical": "LODE_AGENT_BIN_DIR",
    "legacy": "HEAD_AGENT_BIN_DIR",
    "class": "trusted-path-domain"
  },
  {
    "canonical": "LODE_AGENT_CODEX_INSTALLED_POLICY_EXECUTABLE",
    "legacy": "HEAD_AGENT_CODEX_INSTALLED_POLICY_EXECUTABLE",
    "class": "test-harness-target-identity"
  },
  {
    "canonical": "LODE_AGENT_CODEX_INSTALLED_POLICY_EXEC_HELP",
    "legacy": "HEAD_AGENT_CODEX_INSTALLED_POLICY_EXEC_HELP",
    "class": "ordinary-or-test-setting"
  },
  {
    "canonical": "LODE_AGENT_CODEX_INSTALLED_POLICY_SCHEMA_DIRECTORY",
    "legacy": "HEAD_AGENT_CODEX_INSTALLED_POLICY_SCHEMA_DIRECTORY",
    "class": "test-harness-target-identity"
  },
  {
    "canonical": "LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT",
    "legacy": "HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT",
    "class": "test-harness-target-identity"
  },
  {
    "canonical": "LODE_AGENT_GO_WORKER_FIXTURE_ROOT",
    "legacy": "HEAD_AGENT_GO_WORKER_FIXTURE_ROOT",
    "class": "test-harness-target-identity"
  },
  {
    "canonical": "LODE_AGENT_HOST_ENDPOINT_ID",
    "legacy": "HEAD_AGENT_HOST_ENDPOINT_ID",
    "class": "exact-trusted-identity"
  },
  {
    "canonical": "LODE_AGENT_HOST_PROCESS_PROOF",
    "legacy": "HEAD_AGENT_HOST_PROCESS_PROOF",
    "class": "exact-trusted-identity"
  },
  {
    "canonical": "LODE_AGENT_HOST_PROJECT_ROOT",
    "legacy": "HEAD_AGENT_HOST_PROJECT_ROOT",
    "class": "trusted-path-domain"
  },
  {
    "canonical": "LODE_AGENT_HOST_TAB_ID",
    "legacy": "HEAD_AGENT_HOST_TAB_ID",
    "class": "exact-trusted-identity"
  },
  {
    "canonical": "LODE_AGENT_HOST_WORKSPACE_ID",
    "legacy": "HEAD_AGENT_HOST_WORKSPACE_ID",
    "class": "exact-trusted-identity"
  },
  {
    "canonical": "LODE_AGENT_INBOX_REPLY",
    "legacy": "HEAD_AGENT_INBOX_REPLY",
    "class": "ordinary-or-test-setting"
  },
  {
    "canonical": "LODE_AGENT_INSTALL_ROOT",
    "legacy": "HEAD_AGENT_INSTALL_ROOT",
    "class": "trusted-path-domain"
  },
  {
    "canonical": "LODE_AGENT_KEEP_TEST_TMP",
    "legacy": "HEAD_AGENT_KEEP_TEST_TMP",
    "class": "ordinary-or-test-setting"
  },
  {
    "canonical": "LODE_AGENT_LIVE_CODEX_E2E",
    "legacy": "HEAD_AGENT_LIVE_CODEX_E2E",
    "class": "existing-opt-in-external-effect"
  },
  {
    "canonical": "LODE_AGENT_LIVE_CODEX_E2E_MODE",
    "legacy": "HEAD_AGENT_LIVE_CODEX_E2E_MODE",
    "class": "existing-opt-in-external-effect"
  },
  {
    "canonical": "LODE_AGENT_LIVE_RUNTIME",
    "legacy": "HEAD_AGENT_LIVE_RUNTIME",
    "class": "existing-opt-in-external-effect"
  },
  {
    "canonical": "LODE_AGENT_LIVE_RUNTIME_E2E",
    "legacy": "HEAD_AGENT_LIVE_RUNTIME_E2E",
    "class": "existing-opt-in-external-effect"
  },
  {
    "canonical": "LODE_AGENT_LIVE_RUNTIME_E2E_MODE",
    "legacy": "HEAD_AGENT_LIVE_RUNTIME_E2E_MODE",
    "class": "existing-opt-in-external-effect"
  },
  {
    "canonical": "LODE_AGENT_LIVE_RUNTIME_MODEL",
    "legacy": "HEAD_AGENT_LIVE_RUNTIME_MODEL",
    "class": "existing-opt-in-external-effect"
  },
  {
    "canonical": "LODE_AGENT_OPERATIONAL_STATE_ROOT",
    "legacy": "HEAD_AGENT_OPERATIONAL_STATE_ROOT",
    "class": "trusted-path-domain"
  },
  {
    "canonical": "LODE_AGENT_PREFIX_CAPTURE_EXECUTABLE",
    "legacy": "HEAD_AGENT_PREFIX_CAPTURE_EXECUTABLE",
    "class": "test-harness-target-identity"
  },
  {
    "canonical": "LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT",
    "legacy": "HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT",
    "class": "test-harness-target-identity"
  },
  {
    "canonical": "LODE_AGENT_TEST_CODEX_BIN",
    "legacy": "HEAD_AGENT_TEST_CODEX_BIN",
    "class": "test-harness-target-identity"
  },
  {
    "canonical": "LODE_AGENT_TEST_CODEX_HOST_DISCOVERY",
    "legacy": "HEAD_AGENT_TEST_CODEX_HOST_DISCOVERY",
    "class": "existing-opt-in-external-effect"
  },
  {
    "canonical": "LODE_AGENT_TEST_OWNER_CRASH_FIXTURE",
    "legacy": "HEAD_AGENT_TEST_OWNER_CRASH_FIXTURE",
    "class": "test-harness-target-identity"
  },
  {
    "canonical": "LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT",
    "legacy": "HEAD_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT",
    "class": "test-harness-target-identity"
  },
  {
    "canonical": "LODE_AGENT_TEST_TMP",
    "legacy": "HEAD_AGENT_TEST_TMP",
    "class": "ordinary-or-test-setting"
  },
  {
    "canonical": "LODE_AGENT_WORKSPACE_HOST_EXPORT_ROOT",
    "legacy": "HEAD_AGENT_WORKSPACE_HOST_EXPORT_ROOT",
    "class": "trusted-path-domain"
  }
].map(Object.freeze));
export const DISCOVERY_PREFIX_PAIRS = Object.freeze([
  {
    "legacy": "head_bounded_",
    "canonical": "lode_bounded_"
  },
  {
    "legacy": "head_change_",
    "canonical": "lode_change_"
  },
  {
    "legacy": "head_checkpoint_",
    "canonical": "lode_checkpoint_"
  },
  {
    "legacy": "head_compact_",
    "canonical": "lode_compact_"
  },
  {
    "legacy": "head_compaction_",
    "canonical": "lode_compaction_"
  },
  {
    "legacy": "head_conformance_",
    "canonical": "lode_conformance_"
  },
  {
    "legacy": "head_context_",
    "canonical": "lode_context_"
  },
  {
    "legacy": "head_continuity_",
    "canonical": "lode_continuity_"
  },
  {
    "legacy": "head_conversation_",
    "canonical": "lode_conversation_"
  },
  {
    "legacy": "head_core_",
    "canonical": "lode_core_"
  },
  {
    "legacy": "head_delivery_",
    "canonical": "lode_delivery_"
  },
  {
    "legacy": "head_document_",
    "canonical": "lode_document_"
  },
  {
    "legacy": "head_feature_",
    "canonical": "lode_feature_"
  },
  {
    "legacy": "head_git_",
    "canonical": "lode_git_"
  },
  {
    "legacy": "head_graph_",
    "canonical": "lode_graph_"
  },
  {
    "legacy": "head_graphdb_",
    "canonical": "lode_graphdb_"
  },
  {
    "legacy": "head_incremental_",
    "canonical": "lode_incremental_"
  },
  {
    "legacy": "head_lineage_",
    "canonical": "lode_lineage_"
  },
  {
    "legacy": "head_markdown_",
    "canonical": "lode_markdown_"
  },
  {
    "legacy": "head_metric_",
    "canonical": "lode_metric_"
  },
  {
    "legacy": "head_observation_",
    "canonical": "lode_observation_"
  },
  {
    "legacy": "head_onboarding_",
    "canonical": "lode_onboarding_"
  },
  {
    "legacy": "head_pending_",
    "canonical": "lode_pending_"
  },
  {
    "legacy": "head_post_",
    "canonical": "lode_post_"
  },
  {
    "legacy": "head_product_",
    "canonical": "lode_product_"
  },
  {
    "legacy": "head_project_",
    "canonical": "lode_project_"
  },
  {
    "legacy": "head_refresh_",
    "canonical": "lode_refresh_"
  },
  {
    "legacy": "head_release_",
    "canonical": "lode_release_"
  },
  {
    "legacy": "head_run_",
    "canonical": "lode_run_"
  },
  {
    "legacy": "head_runtime_",
    "canonical": "lode_runtime_"
  },
  {
    "legacy": "head_session_",
    "canonical": "lode_session_"
  },
  {
    "legacy": "head_source_",
    "canonical": "lode_source_"
  },
  {
    "legacy": "head_temporal_",
    "canonical": "lode_temporal_"
  },
  {
    "legacy": "head_vcs_",
    "canonical": "lode_vcs_"
  },
  {
    "legacy": "head_worker_",
    "canonical": "lode_worker_"
  },
  {
    "legacy": "head_world_",
    "canonical": "lode_world_"
  }
].map(Object.freeze));

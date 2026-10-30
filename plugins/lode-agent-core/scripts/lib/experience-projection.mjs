import { formatForVerifiedOwner } from "./project-storage-format.mjs";

export const EXPERIENCE_PROJECTION_PROTOCOL_VERSION = "0.1.0";

function item({ id, owner, severity = "notice", actionability: itemActionability = "immediate", summary, blockedOperations = [] }) {
  return { id, owner, ownerLabel: owner === "user" ? "user" : "Lode", severity, actionability: itemActionability, summary, blockedOperations };
}

export function actionability({
  userDecisionRequired = false,
  headActionRequired = false,
  recoveryDependentWorkBlocked = false,
  ordinaryWorkBlocked = false,
  blockedOperations = [],
} = {}) {
  return {
    userDecisionRequired: userDecisionRequired === true,
    headActionRequired: headActionRequired === true,
    recoveryDependentWorkBlocked: recoveryDependentWorkBlocked === true,
    ordinaryWorkBlocked: ordinaryWorkBlocked === true,
    blockedOperations: [...new Set(blockedOperations)].sort(),
  };
}

export function buildAttentionProjection(experience, storage = undefined) {
  const format = formatForVerifiedOwner(storage);
  const owner = format.value("HEAD");
  const core = experience?.readiness?.core || {};
  const product = experience?.readiness?.product || {};
  const recovery = experience?.readiness?.recovery || {};
  const runtime = experience?.runtime || {};
  const items = [];

  if (["relocation_available", "relocation_pending"].includes(core.state)) items.push(item({
    id: "project-location-resume", owner, actionability: "when-resuming-this-project",
    summary: "Existing Project location verified for explicit resume. Session, Run and recovery remain uninspected; no Host binding was restored.",
    blockedOperations: [],
  }));

  if (core.state === "not_initialized") items.push(item({
    id: "core-initialization",
    owner,
    summary: "Initialize the Core only because Lode use was requested for this project.",
    blockedOperations: ["head-managed-capabilities"],
  }));
  if (core.state === "drifted") items.push(item({
    id: "managed-projection-drift",
    owner,
    severity: "integrity",
    actionability: core.projectionDriftOnly ? "when-managed-mutation-is-in-scope" : "immediate",
    summary: "Inspect managed projection drift before a mutating Lode operation.",
    blockedOperations: ["head-managed-mutation"],
  }));
  if (experience?.currentProjectDirectionAvailability?.status === "unavailable") items.push(item({
    id: "current-project-direction-unavailable", owner, severity: "integrity",
    actionability: "when-current-direction-dependent-work-is-in-scope",
    summary: "Current common direction is unavailable. Retained Session context remains readable; assess only dependent effects or direction publication without guessing a revision.",
    blockedOperations: ["current-project-direction-dependent-effects", "checkpoint-direction-publication"],
  }));
  if (recovery.headActionRequired) items.push(item({
    id: "recovery-verification",
    owner,
    severity: "integrity",
    summary: `Inspect recovery readiness for the affected Lode operations (${recovery.reasonCode || recovery.state}).`,
    blockedOperations: recovery.blockedOperations || [],
  }));
  if (product.state === "review_required") items.push(item({
    id: "product-canon-review",
    owner: "user",
    severity: "decision",
    actionability: "when-product-governance-is-in-scope",
    summary: "Product candidates need an explicit review before Product Canon promotion.",
    blockedOperations: ["product-canon-promotion"],
  }));
  if (product.state === "integrity_attention") items.push(item({
    id: "product-integrity", owner, severity: "integrity",
    actionability: "when-product-governance-is-in-scope",
    summary: `Inspect optional Product evidence (${product.reasonCode}); ordinary Core work remains available.`,
    blockedOperations: ["product-governance-dependent-work"],
  }));
  if (["evidence_required", "refresh_required", "migration_required"].includes(product.state)) items.push(item({
    id: "product-governance-follow-up",
    owner,
    actionability: "when-product-governance-is-in-scope",
    summary: "Product governance needs bounded follow-up only when the current task depends on it.",
    blockedOperations: ["product-governance-dependent-work"],
  }));
  if (runtime.state === "project-integration-outdated") items.push(item({
    id: "plugin-integration-update",
    owner,
    summary: "Converge the project integration, then restart the Host to load the configured package.",
    blockedOperations: ["new-plugin-capabilities"],
  }));

  const immediate = items.filter((entry) => entry.actionability === "immediate");
  const userDecisionRequired = immediate.some((entry) => entry.owner === "user");
  const headActionRequired = immediate.some((entry) => entry.owner === owner);
  return {
    kind: format.kind("HeadAttentionProjection"),
    protocolVersion: EXPERIENCE_PROJECTION_PROTOCOL_VERSION,
    status: immediate.length ? "attention" : items.length ? "notice" : "clear",
    items,
    counts: {
      total: items.length,
      userDecision: immediate.filter((entry) => entry.owner === "user").length,
      headAction: immediate.filter((entry) => entry.owner === owner).length,
      availableUserDecision: items.filter((entry) => entry.owner === "user" && entry.actionability !== "immediate").length,
      conditionalHeadAction: items.filter((entry) => entry.owner === owner && entry.actionability !== "immediate").length,
    },
    ...actionability({
      userDecisionRequired,
      headActionRequired,
      recoveryDependentWorkBlocked: recovery.recoveryDependentWorkBlocked,
      ordinaryWorkBlocked: false,
      blockedOperations: items.flatMap((entry) => entry.blockedOperations),
    }),
    authority: {
      plane: "P4",
      advisoryOnly: true,
      persisted: false,
      createsReviewDecision: false,
      writesRecoveryDirection: false,
      grantsAuthorization: false,
    },
  };
}

export function buildPresentationProjection(attention, storage = undefined) {
  const format = formatForVerifiedOwner(storage);
  const mode = attention.userDecisionRequired ? "decision"
    : attention.headActionRequired ? "exception"
      : attention.status === "notice" ? "notice" : "quiet";
  return {
    kind: format.kind("HeadPresentationProjection"),
    protocolVersion: EXPERIENCE_PROJECTION_PROTOCOL_VERSION,
    mode,
    successPolicy: "one-line-unless-details-requested",
    exceptionPolicy: "show-owner-reason-affected-scope-and-next-action",
    technicalDetails: "structured-result-or-json",
    userDecisionRequired: attention.userDecisionRequired,
    headActionRequired: attention.headActionRequired,
    ordinaryWorkBlocked: attention.ordinaryWorkBlocked,
    authority: {
      advisoryOnly: true,
      persisted: false,
      createsReviewDecision: false,
      writesRecoveryDirection: false,
    },
  };
}

export function withExperienceProjections(experience, storage = undefined) {
  const attention = buildAttentionProjection(experience, storage);
  // Public action flags describe the whole entry. Recovery-only flags retain
  // their narrower meaning under readiness.recovery.
  return { ...experience, ...actionability(attention), attention, presentation: buildPresentationProjection(attention, storage) };
}

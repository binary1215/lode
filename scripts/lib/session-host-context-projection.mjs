import path from "node:path";
import { publicToolName } from "./lode-artifact-composition.mjs";
import { fitSelectedBodyGroups, workBodyTuples } from "./session-work-body-organization.mjs";
import { fitSessionWorkDelivery, workOriginalCount } from "./session-work-excerpts.mjs";
import { coreEntryGuidance } from "./lode-entry-guidance.mjs";

// Complete emitted JSON, not just P3 bodies. The Codex resource guard reuses
// the default work-reader size; it is not a token/window or sufficiency claim.
// Claude documents a 10000-character per-string delivery ceiling. UTF-16 length
// is conservative for scalar/grapheme counting. Installed Host support is separate.
export const MAX_CONTEXT_CHARACTERS = { codex: 32768, claude: 10000, opencode: 32768 };
export const COMPACT_SCOPE = "Read-only, non-atomic. Current common/selected P2 apply; history/P3 grant no effects. IDs/digests select originals; reference freshness not inferred. Check current authority for effects.";
const HINT_SCOPE = "Read-only, non-atomic. Current common/selected P2 apply; history/P3 grant no effects. Hints; inspected only. IDs/digests: originals, not freshness. Check current authority for effects.";
export function startupProjection(entry, root, runtime = "claude", groupFitter = fitSelectedBodyGroups) {
  const limit = MAX_CONTEXT_CHARACTERS[runtime];
  const logicalSessionId = entry.workContext?.sessionId || entry.restore?.checkpoint?.sessionId || entry.projectStatus?.project?.sessionId || null;
  const views = [entry.restore?.projection, entry.projectStatus, entry].filter(Boolean);
  // Keep content and its stated diagnosis together, including an explicit null.
  // A null/absent metadata field is not itself an availability diagnosis.
  const directionView = views.find((view) => view.currentProjectDirectionAvailability
    && typeof view.currentProjectDirectionAvailability === "object" && !Array.isArray(view.currentProjectDirectionAvailability))
    || views.find((view) => Object.hasOwn(view, "currentProjectDirection"));
  const common = directionView?.currentProjectDirection ?? null;
  const availability = directionView?.currentProjectDirectionAvailability;
  const checkpoint = entry.restore?.checkpoint;
  const work = entry.workContext;
  const compactScope = work?.omissions?.uninspected > 0 ? HINT_SCOPE : COMPACT_SCOPE;
  const execution = entry.restore?.projection?.currentExecution, pointer = execution?.sessionPointer;
  const showExecution = execution && (execution.status !== "verified" || pointer?.activeRunId || pointer?.pendingReview || pointer?.requiredPlanAction);
  const context = {
    status: entry.status, projectRoot: path.resolve(root), logicalSessionId,
    sessionPurpose: work?.sessionPurpose ?? null,
    currentProjectDirection: common ? { directionId: common.directionId, directionHash: common.directionHash, input: common.input } : null,
    ...(availability && typeof availability === "object" && !Array.isArray(availability)
      ? { currentProjectDirectionAvailability: { status: availability.status, reasonCode: availability.reasonCode,
        dependentEffectsBlocked: availability.dependentEffectsBlocked } } : {}),
    sessionRecovery: checkpoint ? { checkpointId: checkpoint.checkpointId, checkpointDigest: checkpoint.checkpointDigest,
      openReviewIds: checkpoint.openReviewIds, purpose: checkpoint.purpose,
      approvedDecisions: checkpoint.approvedDecisions, historicalPosition: checkpoint.currentPosition,
      historicalNextExpectedResult: checkpoint.nextExpectedResult, historicalApprovalGrantsCurrentEffect: false } : null,
    records: [], omittedEvidenceIds: [], omittedEvidenceCount: workOriginalCount(work),
    workCoverage: work ? { status: work.status, reasonCode: work.reasonCode, omitted: true,
      sourceOriginals: work.coverage?.originals, sourceInspected: work.coverage?.inspected, sourceIncluded: work.coverage?.included,
      ...(work.recordExcerpts?.length ? { sourceExcerpted: work.recordExcerpts.length } : {}) } : null,
    route: logicalSessionId ? { session_id: logicalSessionId } : null,
    scope: work?.omissions?.uninspected > 0 ? compactScope : "Read-only, non-atomic orientation. Current common and selected Session P2 apply; history/P3 grant no effects. Original IDs/digests select verified sources, not this projection. Reference freshness is not inferred. Recheck current authority before an effect.",
    hostCapability: "Verified Host/explicit route only; never guess. No extra bind/save/repeated Session ID.",
    ordinaryWorkBlocked: false, userDecisionRequired: false, persisted: false,
    ...(showExecution ? { currentExecution: { status: execution.status, contentIncluded: false, source: "restore.projection.currentExecution" } } : {}),
    expansion: "",
  };
  const normalScope = context.scope, normalHostCapability = context.hostCapability;
  let compactExpansion = false, executionDetailsOmitted = false;
  const serialize = () => {
    const rootSource = context.projectRootOmitted ? (runtime === "opencode" ? "the verified OpenCode plugin directory" : "the original SessionStart.cwd") : "projectRoot";
    const omittedWork = context.omittedEvidenceCount || work?.omissions?.byBudget || work?.omissions?.uninspected || work?.unavailable?.length
      || work && !["work_context_available", "work_context_not_recorded"].includes(work.status)
      || work?.todoContext?.items?.length && (!context.todoContext || context.todoContext.omittedFromStartup);
    if (entry.status === "session_selection_unresolved") {
      // Common P2 expansion stays prior to optional Session discovery. Missing
      // selection cannot turn a common-direction read into a Session list.
      context.expansion = context.requiredSourceExpansion
        ? publicToolName("head_project_direction_read") + "(project_root:" + rootSource + ")" : "";
    } else if (compactExpansion) {
      const route = "(project_root:" + rootSource + ", ...route)";
      context.expansion = (context.requiredSourceExpansion ? "When needed: " + publicToolName("head_conversation_enter") + route : "")
        + (omittedWork ? (context.requiredSourceExpansion ? "; " : "") + "Omitted work: " + publicToolName("head_session_work_read") + route : "");
    } else {
      context.expansion = "When needed, " + publicToolName("head_conversation_enter") + " with project_root:" + rootSource
        + " and the exact route above reads originals (workContext.sessionPurpose, common direction, checkpoint).";
      if (omittedWork) context.expansion += " Omitted work: " + publicToolName("head_session_work_read") + " with the same root/route.";
    }
    return JSON.stringify(context);
  };
  const exceedsBound = () => serialize().length > limit;
  // Admission always uses the smallest truthful guidance envelope. Long prose
  // may return only with spare capacity after originals, never at their expense.
  context.scope = (showExecution ? "Execution details omitted; expand entry. " : "") + compactScope;
  context.hostCapability = "Verified route only; never guess. No extra bind/save/repeated Session ID.";
  compactExpansion = true;
  // All four latest selected checkpoint fields can carry local direction. Keep
  // them with current common direction/purpose before optional work or metadata.
  // Only a true protected-content overflow reaches whole-block omission. Size
  // and the stable tie order below are serialization rules, not semantic ranks.
  const protectedBlocks = ["sessionRecovery", "sessionPurpose", "currentProjectDirection"]
    .filter((key) => context[key] !== null)
    .map((key, order) => ({ key, order, size: JSON.stringify(context[key]).length }))
    .sort((a, b) => b.size - a.size || a.order - b.order);
  for (const { key } of protectedBlocks) {
    if (!exceedsBound()) break;
    if (key === "currentProjectDirection") context[key] = { directionId: common.directionId, directionHash: common.directionHash, contentIncluded: false };
    else if (key === "sessionRecovery") context[key] = { checkpointId: checkpoint.checkpointId, checkpointDigest: checkpoint.checkpointDigest, contentIncluded: false,
      historicalApprovalGrantsCurrentEffect: false };
    else {
      context.sessionPurpose = null;
      context.sessionPurposeCoverage = { contentIncluded: false, reason: "startup-output-bound", source: "workContext.sessionPurpose" };
    }
    context.requiredSourceExpansion = "Current content omitted; no constraint or cancellation is assumed absent. Expand only for dependent work.";
  }
  // Only a path larger than the remaining minimal envelope reaches this branch.
  // The operational root is unchanged; never render a sliced path as exact.
  if (exceedsBound()) {
    delete context.projectRoot;
    context.projectRootOmitted = true;
    context.projectRootSource = runtime === "opencode" ? "OpenCode.plugin.directory" : "SessionStart.cwd";
  }
  // Each optional addition is checked with its final counts and conditional
  // expansion. It can never evict a protected original that already fitted.
  if (showExecution) {
    context.scope = compactScope;
    context.currentExecution = { status: execution.status,
      sessionPointer: { activeRunId: pointer?.activeRunId ?? null,
        pendingReview: pointer?.pendingReview ? { runId: pointer.pendingReview.runId, wholePlanId: pointer.pendingReview.wholePlanId, resultPacketId: pointer.pendingReview.resultPacketId } : null,
        lastReviewDecisionId: pointer?.lastReviewDecisionId ?? null,
        requiredPlanAction: pointer?.requiredPlanAction ? { kind: pointer.requiredPlanAction.kind, disposition: pointer.requiredPlanAction.disposition,
          wholePlanId: pointer.requiredPlanAction.wholePlanId, reviewDecisionId: pointer.requiredPlanAction.reviewDecisionId } : null } };
    if (exceedsBound()) {
      context.currentExecution = { status: execution.status, contentIncluded: false, source: "restore.projection.currentExecution" };
      executionDetailsOmitted = true;
      context.scope = "Execution details omitted; expand entry. " + compactScope;
    }
  }
  // Open tasks have an independent indexed selection: an older unresolved
  // item must not disappear merely because eight newer notes were selected.
  // They remain P3 observations under current P2, never recovery instructions.
  if (work?.todoContext) {
    const todo = work.todoContext;
    context.todoContext = { status: todo.status, knownOpenCount: todo.knownOpenCount, currentness: todo.currentness,
      coverage: todo.coverage, items: [], omittedFromStartup: todo.items.length, expansion: todo.expansion };
    if (exceedsBound()) context.todoContext = { status: "unknown-or-omitted", contentIncluded: false,
      source: "workContext.todoContext", expansion: "Read selected Session work context; omitted tasks are not completed." };
    else for (const item of todo.items) {
      context.todoContext.items.push(item); context.todoContext.omittedFromStartup--;
      if (exceedsBound()) { context.todoContext.items.pop(); context.todoContext.omittedFromStartup++; }
    }
    if (exceedsBound()) delete context.todoContext;
  }
  const presentRecord = record => {
    // The original content (including reference descriptors) stays intact. Pair
    // byte/owner verification by index instead of repeating the same descriptor
    // and authority prose. Unmatched descriptors stay explicit, never guessed.
    const referenceChecks = (record.references || []).map((ref, index) => {
      const descriptor = record.content?.references?.[index];
      const matches = descriptor && ["path", "digest", "kind"].every(key => descriptor[key] === ref[key]);
      const check = { ...ref };
      if (!matches) return check;
      for (const key of ["path", "digest", "kind"]) delete check[key];
      if (check.semanticFreshness === "not-inferred") delete check.semanticFreshness;
      for (const key of ["instructionAuthority", "recoveryAuthority"]) if (check[key] === false) delete check[key];
      return { referenceIndex: index, ...check };
    });
    return { evidenceId: record.evidenceId, evidenceDigest: record.evidenceDigest, content: record.content,
      ...(referenceChecks.length ? { referenceChecks } : {}),
      ...(record.selectionRole ? { selectionRole: record.selectionRole,
        ...(record.savedActivity ? { savedActivity: record.savedActivity } : {}) } : {}) };
  };
  const applyDelivery = payload => {
    context.records = payload.records;
    if (payload.recordExcerpts?.length) context.recordExcerpts = payload.recordExcerpts;
    else delete context.recordExcerpts;
    context.omittedEvidenceCount = workOriginalCount(work) - context.records.length;
    if (context.records.some(record => record.selectionRole) || context.recordExcerpts?.some(excerpt => excerpt.selectionRole)) {
      context.savedObservationScope = "Saved historical observations coexist; no current live state, success or authority is inferred.";
    } else delete context.savedObservationScope;
  };
  if (work) {
    const fitted = fitSessionWorkDelivery(work, { presentRecord, fits(payload) { applyDelivery(payload); return !exceedsBound(); } });
    applyDelivery(fitted.payload);
  }
  if (context.savedObservationScope && work?.organization) {
    context.workOrganization = { scope: work.organization.scope, roots: work.organization.roots, branchingPredecessors: work.organization.branchingPredecessors,
      unavailableRelations: work.organization.unavailableRelations, uninspectedRelations: work.organization.uninspectedRelations,
      relatedExpansionDeferred: work.organization.relatedExpansionDeferred };
    if (exceedsBound()) delete context.workOrganization;
  }
  if (work) {
    const minimumCoverage = context.workCoverage;
    context.workCoverage = { status: work.status, reasonCode: work.reasonCode, coverage: work.coverage,
      omissions: work.omissions, nextAfterEvidenceId: work.nextAfterEvidenceId };
    if (exceedsBound()) {
      context.workCoverage = { status: work.status, reasonCode: work.reasonCode, omitted: true, reason: "startup-output-bound",
        sourceOriginals: work.coverage?.originals, sourceInspected: work.coverage?.inspected, sourceIncluded: work.coverage?.included,
        ...(work.recordExcerpts?.length ? { sourceExcerpted: work.recordExcerpts.length } : {}),
        nextAfterEvidenceId: work.nextAfterEvidenceId };
      if (exceedsBound()) context.workCoverage = minimumCoverage;
    }
  }
  context.scope = executionDetailsOmitted ? "Execution details omitted; expand entry. " + normalScope : normalScope;
  if (exceedsBound()) context.scope = (executionDetailsOmitted ? "Execution details omitted; expand entry. " : "") + compactScope;
  context.hostCapability = normalHostCapability;
  if (exceedsBound()) context.hostCapability = "Verified route only; never guess. No extra bind/save/repeated Session ID.";
  if (compactExpansion) {
    compactExpansion = false;
    if (exceedsBound()) compactExpansion = true;
  }
  const includedIds = new Set(context.records.map((record) => record.evidenceId));
  for (const record of [...(work?.records || []), ...(work?.recordExcerpts || []).map(excerpt => excerpt.source)]) {
    if (includedIds.has(record.evidenceId) || context.omittedEvidenceIds.length >= 16) continue;
    context.omittedEvidenceIds.push(record.evidenceId);
    if (exceedsBound()) context.omittedEvidenceIds.pop();
  }
  // The owner-verified next call is optional guidance, not an eager inventory or
  // a route. Never displace current direction or originals to repeat its root.
  if (entry.status === "session_selection_unresolved" && entry.sessionDiscovery) {
    context.sessionDiscovery = entry.sessionDiscovery;
    if (exceedsBound()) delete context.sessionDiscovery;
  }
  // Guidance follows fitting originals/Todo/reasons; it never evicts them.
  // Missing fields do not prove delivery, just as local output is no Host/model
  // receipt. Add an explicit omission marker only when that marker also fits.
  context.coreGuidance = coreEntryGuidance();
  if (exceedsBound()) {
    delete context.coreGuidance;
    context.coreGuidanceDelivery = "omitted-output-bound";
    if (exceedsBound()) delete context.coreGuidanceDelivery;
  }
  // Use indices of the actually admitted output, not the upstream selection.
  // Optional grouping never displaces current direction or a fitting body.
  Object.assign(context, groupFitter(workBodyTuples(context.records,
    { projectId: work?.projectId, sessionId: logicalSessionId }), limit - serialize().length));
  if (exceedsBound()) delete context.selectedBodyGroups;
  return serialize();
}

import { resolveOperation } from "./lode-operation-contract.mjs";
import { organizeSelectedWorkBodies, workBodyTuples } from "./session-work-body-organization.mjs";
import { isDeepStrictEqual } from "node:util";
import { formatTerminalGraph, inertTerminalText, terminalBlock } from "./terminal-graph.mjs";

const PRODUCT_LABELS = {
  unavailable: "unavailable until Core initialization",
  not_activated: "not activated",
  inspection_blocked: "inspection blocked by Core drift",
  migration_required: "migration required",
  evidence_required: "evidence required",
  review_required: "review required",
  rejected: "rejected; Core remains usable",
  ready: "ready",
  refresh_required: "World refresh required",
};

const CONTEXT_LABELS = {
  blocked: "blocked until Core is ready",
  "curated-only": "curated evidence only; Product/World remains optional",
  "repository-ready": "current repository World evidence available",
  "world-refresh-required": "stale repository World excluded; refresh required",
};

const RECOVERY_LABELS = {
  "unavailable-until-core-ready": "available after Core initialization",
  "blocked-by-core-drift": "attention required because Core projections drifted",
  "no-current-checkpoint": "no current checkpoint; ordinary Session work is available",
  "verified-current-checkpoint": "checkpoint artifacts verified and restorable; semantic freshness remains a Lode judgment",
  "attention-required": "current checkpoint needs attention before recovery",
};

function compactText(value, maxLength = 180) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function formatBudget(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString("en-US") : "unknown";
}

// Configuration is observable here; actual Host loading/connection is not.
// Keep ordinary work available, including quiet status and preserved files.
function integrationNotices(value) {
  const lines = [], integrations = value.project?.integrations || value.integrations || value.hostIntegration || {};
  const display = text => compactText(inertTerminalText(text), 240);
  const manual = Object.entries(integrations).filter(([, item]) => item?.status === "manual");
  if (manual.length) lines.push(`Host configuration: ${manual.map(([client, item]) => `${display(client)} existing files preserved; generated projection ${[item.projection, item.instructionProjection, item.mcpProjection].filter(Boolean).map(display).join(", ") || "not recorded"}`).join("; ")}. Automatic connection was not verified; ordinary work continues.`);
  if (value.drift?.length) lines.push(`Managed configuration differs: ${value.drift.slice(0, 8).map(item => `${display(item.path || item.kind || "managed artifact")} (${display(item.reason || "changed")})`).join("; ")}${value.drift.length > 8 ? `; ${value.drift.length - 8} more in --json` : ""}. Originals remain untouched; only affected managed operations need follow-up.`);
  return lines;
}

function commandGroups(commands) {
  const groups = { "Core flow": [], Context: [], "Optional Product/World": [], "Advanced and recovery": [] };
  for (const command of commands) {
    if (/\b(context-|world-query|world-temporal|world-history|world-runtime)/u.test(command)) groups.Context.push(command);
    else if (/\b(onboarding|feature-mapping|world-|product-|release-|change-set|change-impact)/u.test(command)) groups["Optional Product/World"].push(command);
    else if (/\b(init|resume|status|doctor|--version)\b/u.test(command)) groups["Core flow"].push(command);
    else groups["Advanced and recovery"].push(command);
  }
  return groups;
}

export function formatHelp(value) {
  const groups = commandGroups(value.commands || []);
  const lines = [
    "Lode Agent Core",
    "In a supported coding conversation, describe the task in ordinary language; Lode handles the internal setup.",
    "Core-first by default. Find bounded graph evidence, use source fallback when needed, and activate Product governance or durable execution for their intended outcomes.",
  ];
  if (["head-direct", "lode-direct"].includes(value.executionMeans?.default)) {
    lines.push("Work directly by default; use available Host tools for useful delegation, then let Lode integrate the results.",
      "If delegation never started or has no remaining effects, continue directly or sequentially; inspect uncertain work before replacement.");
  }
  if (value.surface === "managed-maintenance") lines.push("Managed execution: use it when durable ownership, recovery or effect settlement is needed. Original authorization and effect checks apply.");
  if (value.contextGuidance) lines.push(value.contextGuidance);
  lines.push("");
  for (const [name, commands] of Object.entries(groups)) {
    if (!commands.length) continue;
    lines.push(`${name}:`, ...commands.map((command) => `  ${command}`), "");
  }
  if (value.advancedCommand) lines.push(`Advanced ordinary commands: ${value.advancedCommand}`);
  lines.push("Machine-readable output: add --json");
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatUnavailableSession(value, { doctor = false } = {}) {
  const lines = ["Lode Session selection is unavailable; independent work can continue.",
    "Selected Session, Run and recovery: unavailable (not inspected)."];
  if (value.project) lines.push(`Project identity: ${compactText(value.project.projectId, 160)} (verified; readiness not assessed)`);
  const direction = value.currentProjectDirection;
  if (direction) {
    lines.push(`Current common goal: ${compactText(direction.input.goal, 400)}`);
    for (const [key, label] of [["constraints", "Constraint"], ["decisions", "Common decision"], ["cancelledActions", "Cancelled action"]]) {
      for (const item of direction.input[key]) lines.push(`${label}: ${compactText(item, 300)}`);
    }
  } else lines.push(value.currentProjectDirectionAvailability?.status === "unavailable"
    ? "Current common direction: unavailable, not empty; only direction-dependent effects need Lode follow-up."
    : "Current common direction: not recorded (not an approved empty direction).");
  if (doctor) lines.push("Loaded/configured package: not assessed", "Host restart: not assessed", "Managed projection drift: not assessed");
  lines.push("", value.nextLodeAction ?? value.nextHeadAction,
    "User action: none for independent work. Session-dependent work alone may need selection clarification.",
    "This read restored no Session, granted no authorization and changed no project state. Technical details: --json");
  return `${lines.join("\n")}\n`;
}

export function formatProjectStatus(value, { doctor = false } = {}) {
  if (value?.status === "session_selection_unresolved") return formatUnavailableSession(value, { doctor });
  if (["relocation_available", "relocation_pending"].includes(value?.status)) return [
    `Lode found an existing Project: ${value.status === "relocation_pending" ? "location publication is pending" : "explicit resume is available at this folder"}.`,
    `Retained Project identity: ${value.retainedProject.projectId} (not an active Session selection).`,
    "Session, Run, recovery and Host binding: not inspected or restored.",
    "Resume this existing Project explicitly; do not initialize a replacement. Independent work can continue.",
    "This read changed no files, replayed no execution and granted no authorization.", "",
  ].join("\n");
  const core = value.readiness?.core;
  const product = value.readiness?.product;
  const context = value.readiness?.context;
  const recovery = value.readiness?.recovery;
  const productDecision = product?.state === "review_required"
    ? "Product candidates need review; ordinary work remains available"
    : "none for ordinary work";
  const integrityAttention = core?.state === "drifted" || (recovery?.lodeActionRequired ?? recovery?.headActionRequired);
  const notices = integrationNotices(value);
  if (!doctor && !integrityAttention && value.currentProjectDirectionAvailability?.status === "unavailable") {
    return ["Lode Session context remains available; current common direction is unavailable. Continue independent work; only direction-dependent effects or publication need Lode follow-up.", ...notices, ""].join("\n");
  }
  const next = value.nextAction?.id === "work_directly"
    ? "Continue the user's original task."
    : compactText(value.nextAction?.summary || "Continue with the task.");
  if (!doctor && value.presentation?.mode === "quiet") {
    return [core?.state === "ready" ? "Lode is ready — continue the task." : "Lode is not initialized; ordinary work remains available.", ...notices, ""].join("\n");
  }
  if (!doctor && value.presentation?.mode === "notice") {
    return [`Lode is ready — ordinary work continues; ${value.attention?.items?.length || 0} optional item(s) are available when relevant.`, ...notices, ""].join("\n");
  }
  const lines = [
    core?.state === "ready" ? "Lode is ready — continue the task." : "Lode needs attention before a Lode-managed mutation.",
    "",
    `Project: ${core?.state || value.status}`,
    `Recovery: ${RECOVERY_LABELS[recovery?.state] || recovery?.state || "unknown"}`,
    `Product knowledge: ${PRODUCT_LABELS[product?.state] || product?.state || "unknown"}`,
    `Context: ${CONTEXT_LABELS[context?.state] || context?.state || "unknown"}`,
    `User decision: ${value.attention?.userDecisionRequired ? "required for the listed protected decision" : productDecision}`,
    ...notices,
  ];
  if (integrityAttention) {
    lines.push(core?.state === "drifted"
      ? "Integrity notice: inspect managed projection drift before a mutating Lode operation."
      : "Recovery notice: inspect the checkpoint before relying on recovery; ordinary work remains available when it does not depend on that checkpoint.");
  }
  if (doctor || (value.drift?.length || 0) > 0) {
    lines.push(`Executing CLI/library package: ${value.runtime?.loadedPackageVersion || value.runtime?.activePackageVersion || "unknown"}`);
    lines.push(`Configured package: ${value.runtime?.configuredPackageVersion || "not recorded"}`);
    lines.push("Host tools/loading: not observed by this package inspection.");
    lines.push(`Host restart: ${value.runtime?.restartRequired ? "follow the Host update procedure after project integration convergence" : "not determined from project/package version equality"}`);
    lines.push(`Managed projection drift: ${value.drift?.length || 0}`);
    for (const item of value.drift || []) lines.push(`  - ${item.path || item.kind || "managed artifact"}`);
    if (recovery?.reasonCode) lines.push(`Recovery diagnostic: ${recovery.reasonCode}`);
    if (recovery?.checkpointDiagnosis) lines.push(`Checkpoint diagnosis: ${recovery.checkpointDiagnosis}`);
    if (recovery?.checkpointUpdate?.status) lines.push(`Checkpoint update: ${recovery.checkpointUpdate.status}`);
    if (recovery?.semanticFreshness) lines.push("Semantic freshness: not mechanically determined");
    if (recovery?.observationConsistency?.state) lines.push(`Recovery observation: ${recovery.observationConsistency.state}`);
    const recoveryNext = recovery?.recoveryNextLodeAction ?? recovery?.recoveryNextHeadAction;
    if (recoveryNext?.summary) lines.push(`Recovery next: ${compactText(recoveryNext.summary, 240)}`);
  }
  if (value.nextAction) {
    lines.push("", `Next: ${next}`);
    if (doctor && value.nextAction.entrypoint?.cli) lines.push(`Command: ${value.nextAction.entrypoint.cli}`);
    if (doctor && value.nextAction.entrypoint?.mcpTool) lines.push(`MCP: ${value.nextAction.entrypoint.mcpTool}`);
  }
  if (value.attention?.items?.length) {
    lines.push("", "Attention:");
    for (const item of value.attention.items) lines.push(`  - ${item.ownerLabel ?? (item.owner === "HEAD" ? "Lode" : item.owner)}: ${compactText(item.summary, 240)}`);
  }
  lines.push("", "This is read-only guidance; it grants no authority and changes no project state.");
  return `${lines.join("\n")}\n`;
}

export function formatProjectBootstrap(value) {
  if (value?.status === "session_selection_unresolved") return formatUnavailableSession(value);
  const core = value.readiness?.core;
  const product = value.readiness?.product;
  const recovery = value.readiness?.recovery;
  const ready = core?.state === "ready";
  const needsProductReview = product?.state === "review_required";
  const linking = value.instructionIntegration;
  const preservedLinks = linking?.files?.filter(item => item.status.startsWith("preserved-")) || [];
  const instructionPreservationLabels = {
    "preserved-shared-file": "preserved (shared file)",
    "preserved-unsupported-encoding": "preserved (unsupported encoding)",
  };
  const instructionNotice = preservedLinks.length
    ? `Project instructions: ${linking.files.map(item => `${item.path}: ${instructionPreservationLabels[item.status] || item.status}`).join("; ")}; originals are preserved and ordinary work continues. Actual Host consumption was not verified.`
    : linking?.status === "linked"
    ? "Project instructions: linked; actual Host consumption was not verified."
    : linking?.status === "unavailable"
      ? "Project instruction linking remains unavailable for the affected files; originals are preserved and ordinary work continues."
      : null;
  const integrityAttention = !ready || (recovery?.lodeActionRequired ?? recovery?.headActionRequired);
  const next = value.nextAction?.id === "work_directly"
    ? "Continue the user's original task in this conversation."
    : compactText(value.nextAction?.summary || "Continue with the task.");
  return `${[
    ready ? "Lode is ready." : "Lode could not reach a ready Core state.",
    "",
    `Project: ${value.projectAction || "inspected"}`,
    `Recovery: ${RECOVERY_LABELS[recovery?.state] || recovery?.state || "unknown"}`,
    `Product knowledge: ${PRODUCT_LABELS[product?.state] || product?.state || "unknown"}`,
    `User decision: ${needsProductReview ? "required before Product candidates can be approved; ordinary work remains available" : "none"}`,
    ...(instructionNotice ? [instructionNotice] : []),
    ...integrationNotices(value),
    ...(integrityAttention ? [ready
      ? "Recovery notice: inspect the checkpoint before relying on recovery; ordinary work remains available when independent of it."
      : "Integrity notice: inspect the reported Core boundary before a mutating Lode operation."] : []),
    "",
    `Next: ${next}`,
    "Technical details remain available in the structured result or with --json.",
  ].join("\n")}\n`;
}

// Use only the content and diagnosis returned together by Core. This is a
// presentation helper, not a reader, Session resolver or authority validator.
function formatReturnedRecoveryContext(views, checkpoint, workContext) {
  const supplied = views.filter(Boolean);
  const directionView = supplied.find((view) => view.currentProjectDirectionAvailability
    && typeof view.currentProjectDirectionAvailability === "object" && !Array.isArray(view.currentProjectDirectionAvailability))
    || supplied.find((view) => Object.hasOwn(view, "currentProjectDirection"));
  const commonUnavailable = directionView?.currentProjectDirectionAvailability?.status === "unavailable";
  const direction = directionView?.currentProjectDirection;
  const lines = [];
  if (commonUnavailable) {
    lines.push("Current common direction is unavailable, not empty. Independent work continues; only direction-dependent effects or publication need Lode follow-up.");
  } else if (direction?.input) {
    const input = direction.input;
    if (input.goal === "" && ["constraints", "decisions", "cancelledActions"].every((key) => Array.isArray(input[key]) && input[key].length === 0)) {
      lines.push("Current common direction: explicitly recorded empty goal and lists (not execution authorization).");
    } else {
      lines.push("Current common direction (constraints and cancellations take precedence; not execution authorization):",
        `Goal: ${input.goal}`);
      for (const [key, label] of [["constraints", "Constraint"], ["decisions", "Common decision"], ["cancelledActions", "Cancelled action"]]) {
        for (const item of input[key] || []) lines.push(`${label}: ${item}`);
      }
    }
  } else if (directionView && Object.hasOwn(directionView, "currentProjectDirection") && direction === null) {
    lines.push("Current common direction: not recorded (not an approved empty direction).");
  }
  if (["work_context_available", "work_context_partial", "work_context_not_recorded"].includes(workContext?.status) && workContext.sessionPurpose) {
    lines.push(`Selected Session purpose: ${workContext.sessionPurpose}`);
  }
  if (checkpoint) {
    lines.push("Latest retained Session checkpoint (historical context, not current execution or permission):");
    if (checkpoint.purpose != null) lines.push(`Purpose: ${checkpoint.purpose}`);
    for (const decision of checkpoint.approvedDecisions || []) lines.push(`Previously approved decision: ${decision}`);
    if (checkpoint.currentPosition != null) lines.push(`Historical position: ${checkpoint.currentPosition}`);
    if (checkpoint.nextExpectedResult != null) lines.push(`Historical next expected result: ${checkpoint.nextExpectedResult}`);
  }
  return { commonUnavailable,
    onlyUnrecordedDirection: direction === null && !directionView?.currentProjectDirectionAvailability && lines.length === 1,
    text: lines.length ? `${lines.join("\n")}\n` : "" };
}

export function formatSessionRestore(value) {
  if (value?.status === "session_selection_unresolved") return formatUnavailableSession(value);
  const restored = !value?.status || value.status === "session_restored_from_artifacts" ? value : null;
  const checkpoint = restored?.checkpoint || restored?.projection?.checkpoint;
  const context = formatReturnedRecoveryContext([value?.projection, value], checkpoint);
  return `${[
    !checkpoint ? "No verified Session checkpoint was supplied; ordinary independent work remains available." : context.commonUnavailable
      ? "Lode verified the retained Session checkpoint; current common direction remains unavailable, not empty."
      : "Lode recovered the current direction from verified project artifacts.",
    "",
    context.text,
    ...(checkpoint ? [`Open reviews: ${Array.isArray(checkpoint.openReviewIds) ? checkpoint.openReviewIds.length : 0}`] : []),
    "",
    "A newer real user request takes priority over prepared continuation; this read changed no checkpoint or authority.",
    "Technical details remain available in the structured result or with --json.",
  ].join("\n")}\n`;
}

export function formatConversationRecovery(value) {
  const entry = value?.conversationEntry || value;
  const execution = entry?.restore?.projection?.currentExecution;
  const pointer = execution?.sessionPointer;
  const currentExecution = execution && (execution.status !== "verified" || pointer?.activeRunId || pointer?.pendingReview || pointer?.requiredPlanAction) ? {
    status: execution.status,
    sessionPointer: { activeRunId: pointer?.activeRunId ?? null,
      pendingReview: pointer?.pendingReview ? { runId: pointer.pendingReview.runId, wholePlanId: pointer.pendingReview.wholePlanId, resultPacketId: pointer.pendingReview.resultPacketId } : null,
      lastReviewDecisionId: pointer?.lastReviewDecisionId ?? null,
      requiredPlanAction: pointer?.requiredPlanAction ? { kind: pointer.requiredPlanAction.kind, disposition: pointer.requiredPlanAction.disposition,
        wholePlanId: pointer.requiredPlanAction.wholePlanId, reviewDecisionId: pointer.requiredPlanAction.reviewDecisionId } : null },
  } : null;
  const executionText = currentExecution ? `Canonical execution observation (${currentExecution.status}):\n${JSON.stringify(currentExecution)}\n` : "";
  if (entry?.status === "session_selection_unresolved") return formatUnavailableSession(entry);
  const restored = entry?.restore?.status === "session_restored_from_artifacts" ? entry.restore : null;
  const context = formatReturnedRecoveryContext([entry?.restore?.projection, entry?.projectStatus, entry],
    restored?.checkpoint || restored?.projection?.checkpoint, entry?.workContext);
  const lines = [];
  if (value?.status === "compaction_lifecycle_prepared") {
    lines.push(
      "Lode and the Host prepared compaction recovery automatically.",
      "The exact P2 direction is checkpointed and the one-time transport token stays Host-local.",
      "User action: none.",
    );
  } else if (entry?.status === "conversation_direction_restored") {
    lines.push(
      "Lode restored the verified Session checkpoint automatically.",
      "User action: none — continue the task from the original objective.",
    );
  } else if (entry?.status === "conversation_ready") {
    lines.push(
      "Lode conversation entry is ready.",
      "No recovery checkpoint exists, so ordinary work continues without a recovery gate.",
      "User action: none.",
    );
  } else {
    lines.push(
      "Lode could not verify recovery-dependent direction automatically.",
      `Reason: ${entry?.reasonCode || value?.reasonCode || "recovery evidence needs inspection"}`,
      "Ordinary independent work remains available; only work that depends on the unverified checkpoint is paused.",
      "User action: none unless Lode identifies a material decision after inspection.",
    );
  }
  if (["quiet", "notice"].includes(value?.presentation?.mode) && !value?.conversationEntry && ["conversation_ready", "conversation_direction_restored"].includes(value?.status)) {
    const suffix = value.presentation.mode === "notice" ? `; ${value.attention?.items?.length || 0} optional item(s) remain available when relevant` : "";
    const work = entry.workContext;
    const emptyQuiet = value.presentation.mode === "quiet" && value.status === "conversation_ready" && context.onlyUnrecordedDirection
      && quietEmptyWork(work) && !executionText;
    return `${value.status === "conversation_direction_restored" ? "Lode restored the verified Session checkpoint — continue the task" : "Lode is ready — continue the task"}${suffix}.\n${emptyQuiet ? "" : context.text}${executionText}${formatSessionWorkContext(entry.workContext, { boundaryShown: Boolean(context.text) })}${formatRelatedNativeWork(entry.relatedNativeWorkContext)}`;
  }
  for (const attention of entry?.attention?.items || []) {
    if (attention.actionability === "immediate") lines.push(`${attention.ownerLabel ?? (attention.owner === "HEAD" ? "Lode" : attention.owner)} follow-up: ${compactText(attention.summary, 300)}`);
  }
  if (value?.status === "host_lifecycle_unavailable") {
    lines.push("Host compaction hooks are unavailable; first-turn artifact restore still works and provider compaction remains Host-owned.");
  } else if (value?.status === "compaction_lifecycle_prepared") {
    lines.push("The Host retained the one-time continuation internally; no token or lifecycle JSON is required from the user.");
  } else if (value?.status === "provider_compaction_outcome_uncertain") {
    lines.push("The provider outcome is uncertain and will not be replayed automatically. Verified P2 direction remains available.");
  } else if (value?.status === "conversation_direction_restored_without_transport_continuation") {
    lines.push("Transport continuation was unavailable, so Lode will continue as a fresh logical Lode from verified P2 artifacts.");
  } else if (value?.status === "compaction_lifecycle_continued" || value?.status === "compaction_lifecycle_already_continued") {
    lines.push("Verified continuation converged; duplicate Host delivery cannot apply it twice.");
  } else if (value?.status === "provider_compaction_failed" || value?.status === "provider_compaction_failure_already_recorded") {
    lines.push("Provider compaction failed; only that epoch was closed and verified P2 direction remains available.");
  } else if (value?.status === "compaction_lifecycle_superseded") {
    lines.push("A newer real user turn superseded the older prepared continuation.");
  } else if (["head_direction_required", "lode_direction_required"].includes(value?.status)) {
    lines.push("Provider Lode must author the current bounded recovery direction internally; the user is not asked to fill a schema.");
  }
  lines.push("", "Technical details: use the structured result or --json");
  return `${lines.join("\n")}\n${context.text}${executionText}${formatSessionWorkContext(entry.workContext, { boundaryShown: Boolean(context.text) })}${formatRelatedNativeWork(entry.relatedNativeWorkContext)}`;
}

function formatRelatedNativeWork(value) {
  if (!value?.sources?.length) return "";
  return "\nRelated historical P3 from observed native ancestry — not this child's direction, approval or copied fork-cutoff history:\n"
    + value.sources.map(source => `Related source ${JSON.stringify(source.workContext.sessionId)} (${source.relation}; selected when observed; reference records read later):\n`
      + (source.recordRead ? `Input provenance: ${JSON.stringify(source.recordRead)}. Later records are not proven fork-time input.\n` : "Historical input, delivery and model use are unknown.\n")
      + formatSessionWorkContext(source.workContext, { boundaryShown: true })).join("\n");
}

const originalObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function originalField(location, value) {
  if (typeof value !== "string" || value === "") return `${location}: ${JSON.stringify(value, null, 2)}\n`;
  // The fence belongs to the display, never to the original string. Even
  // embedded Markdown, whitespace and code fences remain literal data.
  const longest = (value.match(/`+/gu) || []).reduce((length, run) => Math.max(length, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${location} (original text):\n${fence}text\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}\n`;
}

function originalFacts(value, keys, location, handled) {
  return keys.filter(key => Object.hasOwn(value, key) && !handled.has(key)).map(key => {
    handled.add(key);
    return `${location ? location + "." : ""}${key}: ${JSON.stringify(value[key])}\n`;
  }).join("");
}

function originalRemainder(value, handled, location) {
  const residual = Object.fromEntries(Object.entries(value).filter(([key]) => !handled.has(key)));
  return Object.keys(residual).length ? `Additional original fields at ${location}:\n${JSON.stringify(residual, null, 2)}\n` : "";
}

function originalList(value, location) {
  return value.length ? value.map((item, index) => originalField(`${location}[${index}]`, item)).join("") : originalField(location, value);
}

const todoOriginalFields = ["todoId", "task", "status", "origin", "nextAction", "reason", "progress", "priority", "prior", "resolves", "relatedEvidence"];
function originalTodo(value, location, sources = []) {
  if (!originalObject(value)) return originalField(location, value);
  const handled = new Set();
  let text = originalFacts(value, ["todoId", "status"], location, handled);
  const source = sources.find(source => source.evidenceId === value.revision?.evidenceId && source.evidenceDigest === value.revision?.evidenceDigest
    && source.todo.todoId === value.todoId && todoOriginalFields.every(key => isDeepStrictEqual(value[key], source.todo[key])));
  if (source) {
    text += `Exact task fields already displayed at ${source.location}; same original ID/digest, not a new status judgment.\n`;
    for (const key of todoOriginalFields) if (Object.hasOwn(value, key)) handled.add(key);
  } else {
    text += originalFacts(value, ["origin"], location, handled);
    for (const key of ["task", "nextAction", "reason", "progress", "priority"]) if (Object.hasOwn(value, key)) {
      text += originalField(`${location}.${key}`, value[key]); handled.add(key);
    }
    text += originalFacts(value, ["prior", "resolves", "relatedEvidence"], location, handled);
  }
  if (value.status === "conflict" && Array.isArray(value.revisions)) {
    handled.add("revisions");
    text += "Recorded conflicting branches; no time-based winner:\n";
    for (const [index, revision] of value.revisions.entries()) text += originalTodo(revision, `${location}.revisions[${index}]`, sources);
  }
  text += originalFacts(value, ["revision", "resolution", "missingPriors", "references", "referenceFreshness"], location, handled);
  markKnownNeutralFields(value, handled, { authorityChanged: false, historicalObservationIsCompletion: false });
  return text + originalRemainder(value, handled, location);
}

function formatRecordedTasks(value, work, boundaryShown = false) {
  if (!originalObject(value) || !Array.isArray(value.items)) return originalField("workContext.todoContext", value);
  const handled = new Set(["items"]), sources = [];
  for (const [index, record] of work.records.entries()) if (record.kind === "Evidence" && record.subtype === "SessionWorkEvidence"
    && record.projectId === work.projectId && record.sessionId === work.sessionId && record.evidenceId && record.evidenceDigest) {
    for (const [todoIndex, todo] of (Array.isArray(record.content?.todos) ? record.content.todos : []).entries()) if (originalObject(todo)) {
      sources.push({ todo, evidenceId: record.evidenceId, evidenceDigest: record.evidenceDigest,
        location: `workContext.records[${index}].content.todos[${todoIndex}]` });
    }
  }
  let text = `Recorded tasks: ${value.status}; known unresolved: ${value.knownOpenCount ?? "unknown"}.`
    + (boundaryShown ? "\n" : " Current P2 direction/cancellations apply; coverage is not whole-work completion.\n");
  for (const [index, item] of value.items.entries()) text += originalTodo(item, `workContext.todoContext.items[${index}]`, sources);
  text += originalFacts(value, ["status", "knownOpenCount", "knownItemCount", "currentness", "coverage", "nextAfterTodoId", "nextScanAfterEvidenceId", "expansion"], "workContext.todoContext", handled);
  markKnownNeutralFields(value, handled, { persisted: false, recoveryAuthority: false, instructionAuthority: false, executionReplayAllowed: false, ordinaryWorkBlocked: false });
  for (const key of ["projectId", "sessionId"]) if (typeof value[key] === "string" && value[key] === work[key]) handled.add(key);
  return text + originalRemainder(value, handled, "workContext.todoContext");
}

function originalWorkBody(value, location, explainFields = false) {
  if (!originalObject(value) || !Object.keys(value).length) return originalField(location, value);
  const handled = new Set();
  let text = "";
  if (Array.isArray(value.workTopics)) {
    text += "Authored work topics (navigation only):\n" + originalList(value.workTopics, `${location}.workTopics`);
    handled.add("workTopics");
  }
  if (Object.hasOwn(value, "executionObservation")) {
    text += `Saved execution observation (historical; qualifies its exact target only):\n${JSON.stringify(value.executionObservation, null, 2)}\n`;
    handled.add("executionObservation");
  }
  if (Object.hasOwn(value, "summary")) { text += originalField(`${location}.summary`, value.summary); handled.add("summary"); }
  if (Array.isArray(value.judgments)) {
    if (explainFields && value.judgments.length) text += "Saved judgments and reasons:\n";
    if (!value.judgments.length) text += originalField(`${location}.judgments`, value.judgments);
    for (const [index, judgment] of value.judgments.entries()) {
      const at = `${location}.judgments[${index}]`, keys = new Set();
      if (!originalObject(judgment) || !Object.keys(judgment).length) { text += originalField(at, judgment); continue; }
      for (const key of ["assessment", "reason"]) if (Object.hasOwn(judgment, key)) {
        text += originalField(`${at}.${key}`, judgment[key]); keys.add(key);
      }
      if (Array.isArray(judgment.alternatives)) {
        if (explainFields && judgment.alternatives.length) text += "Alternatives considered in this saved judgment:\n";
        text += originalList(judgment.alternatives, `${at}.alternatives`); keys.add("alternatives");
      }
      text += originalRemainder(judgment, keys, at);
    }
    handled.add("judgments");
  }
  for (const key of ["observedWork", "pending", "unknowns", "suggestedFollowUp"]) if (Array.isArray(value[key])) {
    if (explainFields && value[key].length) text += ({
      observedWork: "Recorded changes and results:\n", pending: "Recorded remaining work:\n",
      unknowns: "Recorded uncertainty:\n", suggestedFollowUp: "Historical suggestions; not execution permission:\n",
    })[key];
    text += originalList(value[key], `${location}.${key}`); handled.add(key);
  }
  if (Array.isArray(value.todos)) {
    handled.add("todos");
    text += "Recorded Todo revisions (historical; not current authority):\n";
    for (const [index, todo] of value.todos.entries()) text += originalTodo(todo, `${location}.todos[${index}]`);
    if (!value.todos.length) text += originalField(`${location}.todos`, value.todos);
  }
  return text + originalRemainder(value, handled, location);
}

function commonStoredWorkFields(entries, label, bodyKey) {
  const common = {}, keys = new Set();
  const result = () => ({ keys, text: keys.size
    ? `Common stored fields for ${entries.map(({ index }) => `${label}[${index}]`).join(", ")}:\n${JSON.stringify(common, null, 2)}\n` : "" });
  const first = entries[0]?.value;
  // This is display factoring of stored own fields, not inferred inheritance.
  // Ambiguous owners, non-work members and unsupported bodies stay individual.
  if (entries.length < 2 || !entries.every(({ value }) => originalObject(value)
    && ["projectId", "sessionId", "kind", "subtype", bodyKey].every(key => Object.hasOwn(value, key))
    && value.kind === "Evidence" && value.subtype === "SessionWorkEvidence" && originalObject(value[bodyKey])
    && ["projectId", "sessionId"].every(key => typeof value[key] === "string" && value[key].length > 0 && value[key] === first[key]))) return result();
  const encoding = value => {
    let supported = true;
    try {
      const encoded = JSON.stringify(value, (_key, item) => {
        if (["undefined", "function", "symbol", "bigint"].includes(typeof item)
          || typeof item === "number" && !Number.isFinite(item)) supported = false;
        return item;
      });
      return supported && typeof encoded === "string" ? encoded : undefined;
    } catch { return undefined; }
  };
  for (const key of ["projectId", "sessionId", "kind", "subtype", "schemaVersion", "protocol", "authorityBoundary"]) {
    if (!Object.hasOwn(first, key)) continue;
    const encoded = encoding(first[key]);
    if (encoded !== undefined && entries.every(({ value }) => Object.hasOwn(value, key)
      && typeof value[key] === typeof first[key] && encoding(value[key]) === encoded)) {
      keys.add(key); common[key] = first[key];
    }
  }
  return result();
}

function markKnownNeutralFields(value, handled, expected) {
  // Closed, producer-specific exact values only. This is display factoring,
  // never a validator; unexpected values and new fields keep their old residual.
  for (const [key, neutral] of Object.entries(expected)) if (Object.hasOwn(value, key) && value[key] === neutral) handled.add(key);
}

function markRenderedBodyGroups(value, handled, entries, bodyKey, owner) {
  if (!Object.hasOwn(value, "selectedBodyGroups")) return;
  try {
    const tuples = workBodyTuples(entries.map(entry => entry.value), { ...owner, bodyKey })
      .map((tuple, index) => ({ ...tuple, index: entries[index].index }));
    const organized = organizeSelectedWorkBodies(tuples);
    if (isDeepStrictEqual(value.selectedBodyGroups, { ...organized, omittedGroups: 0 })) handled.add("selectedBodyGroups");
  } catch { /* Optional display comparison failure keeps the original residual. */ }
}

function originalWorkRecord(value, location, bodyKey, commonKeys = [], compact = false, explainFields = false) {
  if (!originalObject(value) || !Object.keys(value).length) return originalField(location, value);
  const handled = new Set(commonKeys);
  if (compact && bodyKey === "workContent" && value.kind === "Evidence" && value.subtype === "SessionWorkEvidence") {
    markKnownNeutralFields(value, handled, { instructionAuthority: false, promotionAuthority: false,
      recoveryAuthority: false, executionAuthority: false, ordinaryWorkBlocked: false });
  }
  let text = originalFacts(value, ["projectId", "sessionId", "ownerSessionId", "owner",
    "reviewState", "freshness", "contentScope", "contentPartial"], "", handled);
  const activity = value.savedActivity, coverage = value.workContentCoverage;
  if (originalObject(activity)) text += originalFacts(activity, ["states"], "savedActivity", new Set());
  if (originalObject(coverage)) text += originalFacts(coverage, ["partial"], "workContentCoverage", new Set());
  if (Object.hasOwn(value, bodyKey)) { text += originalWorkBody(value[bodyKey], bodyKey, explainFields); handled.add(bodyKey); }
  text += originalFacts(value, ["evidenceId", "nodeId", "kind", "subtype", "selectionRole"], "", handled);
  if (Array.isArray(value.workContentExcerpts)) {
    if (!value.workContentExcerpts.length) text += originalField("workContentExcerpts", []);
    for (const [index, excerpt] of value.workContentExcerpts.entries()) {
      const at = `workContentExcerpts[${index}]`, keys = new Set();
      if (!originalObject(excerpt)) { text += originalField(at, excerpt); continue; }
      text += originalFacts(excerpt, ["field", "index", "subfield", "alternativeIndex", "start", "end", "totalCharacters"], at, keys);
      if (Object.hasOwn(excerpt, "text")) { text += originalField(`${at}.text`, excerpt.text); keys.add("text"); }
      text += Object.keys(excerpt).length ? originalRemainder(excerpt, keys, at) : originalField(at, excerpt);
    }
    handled.add("workContentExcerpts");
  }
  if (originalObject(activity)) {
    text += Object.keys(activity).length ? originalRemainder(activity, new Set(["states"]), "savedActivity") : originalField("savedActivity", activity);
    handled.add("savedActivity");
  }
  if (originalObject(coverage)) {
    text += Object.keys(coverage).length ? originalRemainder(coverage, new Set(["partial"]), "workContentCoverage") : originalField("workContentCoverage", coverage);
    handled.add("workContentCoverage");
  }
  return text + originalRemainder(value, handled, bodyKey === "content" ? "record" : "node");
}

function groupedWorkBodies(entries, bodyKey, owner, commonKeys, compact = false, explainFields = false) {
  const label = bodyKey === "content" ? "Record" : "Node", array = bodyKey === "content" ? "records" : "nodes";
  const tuples = workBodyTuples(entries.map(entry => entry.value), { ...owner, bodyKey })
    .map((tuple, index) => ({ ...tuple, index: entries[index].index }));
  const organized = organizeSelectedWorkBodies(tuples), byIndex = new Map(entries.map(entry => [entry.index, entry.value]));
  let text = organized.groups.length ? `${organized.scope}\n` : "";
  for (const group of organized.groups) {
    text += `Session work group (${JSON.stringify(group.sessionId)}):\n`;
    text += `Declared historical work root: ${group.rootKind === "standalone" ? "none; standalone saved original " : ""}${JSON.stringify(group.root)}\n`;
    if (group.rootBodyIndex === null) text += "Root body not in returned selection; absence is not inferred.\n";
    else if (!group.recordIndices.includes(group.rootBodyIndex)) text += `Root body: ${label}[${group.rootBodyIndex}], displayed in its own declared group, not repeated.\n`;
    for (const index of group.recordIndices) {
      text += `${label}[${index}]:\n${originalWorkRecord(byIndex.get(index), `${array}[${index}]`, bodyKey, commonKeys, compact, explainFields)}`;
    }
  }
  return text;
}

function formatWorkExcerpts(excerpts) {
  let text = "Partial original excerpts: fields may omit conditions; this is neither complete recovery nor approval. Expand the exact original only when needed.\n";
  for (const [index, excerpt] of excerpts.entries()) {
    const at = `workContext.recordExcerpts[${index}]`, handled = new Set(["fields"]);
    if (!originalObject(excerpt)) { text += originalField(at, excerpt); continue; }
    text += originalFacts(excerpt, ["source", "partial", "selectionRole"], at, handled);
    for (const [fieldIndex, field] of (excerpt.fields || []).entries()) {
      const location = `${at}.fields[${fieldIndex}]`, keys = new Set();
      if (!originalObject(field)) { text += originalField(location, field); continue; }
      text += originalFacts(field, ["path", "complete", "range", "group"], location, keys);
      if (Object.hasOwn(field, "value")) { text += originalField(location + ".value", field.value); keys.add("value"); }
      text += originalRemainder(field, keys, location);
    }
    text += originalFacts(excerpt, ["emptyValues", "coverage", "referenceChecks", "expansion"], at, handled);
    text += originalRemainder(excerpt, handled, at);
  }
  return text;
}

function quietEmptyTodo(value, work) {
  if (value === undefined) return true;
  // Factor only the exact known empty producer shape. Unexpected conditions,
  // including false/zero/null/empty unknown fields, must remain visible.
  return isDeepStrictEqual(value, {
    kind: "SessionTodoProjection", authorityPlane: "P4", projectId: work.projectId, sessionId: work.sessionId,
    persisted: false, recoveryAuthority: false, instructionAuthority: false, executionReplayAllowed: false, ordinaryWorkBlocked: false,
    status: "inspected-page", items: [],
    knownOpenCount: 0, knownItemCount: 0, currentness: "within-inspected-originals-only",
    coverage: { status: "all-current-originals-inspected", originalCount: 0,
      indexedTaskRevisionRecords: 0, observedTaskMetadataRecords: 0, indexCoverage: "unknown",
      indexHintMismatchCount: 0, indexHintMismatches: [], inspectedOriginals: 0, verifiedOriginals: 0,
      uninspectedOriginals: 0, unindexedOriginals: 0, indexIsAuthority: false, recentWorkLimitApplied: false,
      unavailable: [], unavailableOmitted: 0, omittedItems: 0, omittedItemIds: [], uninspectedCandidateRevisions: 0 },
    nextAfterTodoId: null, nextScanAfterEvidenceId: null,
    expansion: "Use session-work-read todo_id for an exact item, after_todo_id for more open items, or scan_todos with after_evidence_id for bounded original pages when index coverage is unknown. Pages do not establish unseen successors are absent.",
    scope: "Explicit HEAD-recorded P3 task revisions, not live activity, user approval or P2 direction. Current constraints/cancellations take precedence. Indexed absence is not completeness.",
  });
}

function quietEmptyWork(value) {
  if (value?.kind !== "SessionWorkContextProjection" || value.authorityPlane !== "P4"
    || value.status !== "work_context_not_recorded" || value.coverage?.originals !== 0
    || value.records?.length !== 0 || value.recordExcerpts !== undefined || !quietEmptyTodo(value.todoContext, value)) return false;
  const interpretations = ["Lode", "HEAD"].map(name => `P3 ${name}-authored historical evidence, not current direction, approval, or proof of an external effect. Current Project constraints and selected Session P2 take precedence.`);
  if (!interpretations.includes(value.interpretation) || value.nextAfterEvidenceId !== null
    || value.coverage.usedCharacters !== 2 || !Number.isSafeInteger(value.coverage.maxRecords) || value.coverage.maxRecords < 1
    || !Number.isSafeInteger(value.coverage.maxCharacters) || value.coverage.maxCharacters < 2) return false;
  const keys = new Set(["kind", "authorityPlane", "projectId", "sessionId", "sessionPurpose", "basis", "latestCheckpointId",
    "persisted", "recoveryAuthority", "instructionAuthority", "promotionAuthority", "executionReplayAllowed", "ordinaryWorkBlocked",
    "interpretation", "status", "records", "recordExcerpts", "todoContext", "unavailable", "coverage", "omissions", "nextAfterEvidenceId", "expansion"]);
  if (Object.keys(value).some(key => !keys.has(key))) return false;
  const coverageKeys = new Set(["originals", "inspected", "valid", "unavailable", "included", "maxRecords", "maxCharacters", "usedCharacters", "characterBudgetScope", "selection"]);
  const omissionKeys = new Set(["uninspected", "byBudget", "evidenceIds", "omittedIdCount", "unavailableDetailCount"]);
  if (Object.keys(value.coverage || {}).some(key => !coverageKeys.has(key)) || Object.keys(value.omissions || {}).some(key => !omissionKeys.has(key))) return false;
  if (["persisted", "recoveryAuthority", "instructionAuthority", "promotionAuthority", "executionReplayAllowed", "ordinaryWorkBlocked"].some(key => Object.hasOwn(value, key) && value[key] !== false)) return false;
  return ["inspected", "valid", "unavailable", "included"].every(key => value.coverage[key] === 0)
    && ["uninspected", "byBudget", "omittedIdCount", "unavailableDetailCount"].every(key => value.omissions?.[key] === 0)
    && Array.isArray(value.unavailable) && value.unavailable.length === 0
    && Array.isArray(value.omissions?.evidenceIds) && value.omissions.evidenceIds.length === 0;
}

export function formatSessionWorkContext(value, { boundaryShown = false } = {}) {
  if (value == null || quietEmptyWork(value)) return "";
  const heading = boundaryShown ? "Recorded Session work (historical P3):\n" : "Selected Session work evidence (P3, not current direction or permission):\n";
  if (!originalObject(value) || !Array.isArray(value.records)) return heading + originalField("workContext", value);
  const handled = new Set(["records"]);
  let text = heading + originalFacts(value, ["sessionPurpose", "status", "projectId", "sessionId"], "workContext", handled);
  if (value.kind === "SessionWorkContextProjection") {
    if (!boundaryShown) text += "Read-only historical display; current Project constraints and selected Session P2 take precedence."
      + (value.ordinaryWorkBlocked === false ? " Ordinary work remains available.\n" : "\n");
    markKnownNeutralFields(value, handled, { persisted: false, recoveryAuthority: false, instructionAuthority: false,
      promotionAuthority: false, executionReplayAllowed: false, ordinaryWorkBlocked: false,
      interpretation: "P3 Lode-authored historical evidence, not current direction, approval, or proof of an external effect. Current Project constraints and selected Session P2 take precedence." });
    markRenderedBodyGroups(value, handled, value.records.map((record, index) => ({ index, value: record })), "content", value);
  }
  if (!value.records.length) text += originalField("workContext.records", value.records);
  const common = commonStoredWorkFields(value.records.map((record, index) => ({ index, value: record })), "Record", "content");
  text += common.text;
  text += groupedWorkBodies(value.records.map((record, index) => ({ index, value: record })), "content", value, common.keys, false, true);
  if (Array.isArray(value.recordExcerpts)) { handled.add("recordExcerpts"); text += formatWorkExcerpts(value.recordExcerpts); }
  if (value.todoContext) { handled.add("todoContext"); text += formatRecordedTasks(value.todoContext, value, true); }
  return text + originalRemainder(value, handled, "workContext");
}


function formatSessionWorkRecord(value) {
  if (value?.status === "session_selection_unresolved") return formatUnavailableSession(value);
  return `Selected Session work evidence: ${value?.status === "session_work_evidence_reused" ? "already retained; no write" : "retained"}.
Evidence: ${value?.evidence?.evidenceId || "unknown"}
No checkpoint, approval or effect was created or replayed.\n`;
}

export function formatOnboardingGuide(value) {
  const review = value?.review || {};
  const lines = [];
  if (["awaiting_review", "revision_required"].includes(value?.status)) {
    lines.push(
      "Product meaning needs your review.",
      "",
      `Subject: ${review.candidateCount || 0} evidence-linked Product candidates`,
      "Why now: candidates cannot become Product Canon without your explicit decision.",
    );
    for (const candidate of (review.candidates || []).slice(0, 5)) {
      lines.push(`  - ${compactText(candidate.name || "unnamed evidence-linked candidate", 120)} (${candidate.productKind || "candidate"})`);
    }
    if (review.truncated) lines.push(`  - ${Math.max(0, (review.candidateCount || 0) - (review.returnedCandidateCount || 0))} more candidates require inspection before a complete accept-all review.`);
    lines.push(
      `Unknowns: ${review.unknownCount || 0}`,
      "Options: accept all, accept a selection, revise, or reject.",
      "Recommendation: Lode should assess the evidence in this conversation; Core supplies no automatic disposition.",
      "",
      "Reply in natural language. Lode will re-read the exact current candidate set before applying an unambiguous decision.",
    );
  } else if (value?.status === "ready") {
    lines.push("Product knowledge is reviewed and ready for task-scoped use.", "User decision: none.", "Next: continue the original task.");
  } else {
    lines.push(
      `Product onboarding: ${value?.status || "inspection required"}.`,
      `Next: ${value?.nextAction || "inspect the current state"}.`,
      `User input needed: ${(value?.materialChoicesRequired || []).length ? value.materialChoicesRequired.join(", ") : "none"}.`,
    );
  }
  lines.push("", "This guidance is non-authoritative; technical IDs remain in the structured result.");
  return `${lines.join("\n")}\n`;
}

export function formatFeatureMappingStatus(value) {
  const candidates = value?.candidateSet?.candidates || [];
  const lines = [];
  if (value?.status === "awaiting_review") {
    const recovery = value?.reviewRecovery || null;
    const readiness = value?.reviewReadiness || null;
    if (recovery?.requiresNewUserDecision === false) {
      lines.push(
        "The Feature mapping decision is already saved.",
        "User decision: none — do not ask the user to approve or reject it again.",
        `Lode action: ${compactText(readiness?.nextAction || "retry the unchanged saved decision to finish its pending derived state update.", 240)}`,
      );
    } else if (readiness?.runConflict) {
      lines.push(
        "Feature mapping review is waiting for the current Run boundary.",
        "User decision: none for this mapping now.",
        `Next: ${compactText(readiness.nextAction || "finish the current Run or its pending review, then inspect mapping readiness again.", 240)}`,
      );
    } else if (readiness && !readiness.acceptanceAvailable) {
      lines.push(
        "Feature mapping evidence changed after the proposal.",
        "Acceptance is unavailable for this outdated candidate set.",
      );
      if (readiness.explicitRejectionAvailable) {
        lines.push(
          "Available action: explicitly reject this exact outdated set, then have Lode propose fresh evidence.",
          "Earlier approved mappings remain unchanged.",
        );
      } else {
        lines.push(`Next: ${compactText(readiness.nextAction || "inspect the structured readiness state before taking action.", 240)}`);
      }
    } else {
      lines.push(
        "Feature-to-code relationships need your review.",
        "",
        `Subject: ${candidates.length} evidence-linked mapping candidates`,
        "Why now: proposed relationships remain evidence until an explicit review.",
      );
      for (const candidate of candidates.slice(0, 5)) {
        lines.push(`  - ${compactText(candidate.explanation || candidate.description || "evidence-linked mapping proposal", 160)}`);
      }
      if (candidates.length > 5) lines.push(`  - ${candidates.length - 5} more candidates`);
      lines.push(
        "Options: accept all, accept a selection, or reject.",
        "Recommendation: none is generated mechanically; Lode assesses the exact evidence.",
        "",
        "Reply in natural language. Lode will verify the unchanged candidate set before applying the decision.",
      );
    }
  } else if (value?.status === "reviewed") {
    lines.push("Feature mappings have an explicit review.", "Next: use reviewed relationships as task evidence when relevant.");
  } else {
    lines.push(`Feature mapping: ${value?.status || "not started"}.`, `Next: ${compactText(value?.nextAction || "inspect only when the task needs this mapping.")}`);
  }
  lines.push("", "Product Canon is unchanged; technical IDs remain in the structured result.");
  return `${lines.join("\n")}\n`;
}

export function formatChangeSetStatus(value) {
  const candidates = value?.candidateSet?.candidates || [];
  const recovery = value?.reviewRecovery || null;
  const readiness = value?.reviewReadiness || null;
  const lines = [];
  if (value?.status === "awaiting_review" && recovery?.requiresNewUserDecision === false) {
    lines.push(
      "The Change impact decision is already saved.",
      "User decision: none — do not ask the user to approve or reject it again.",
      `Lode action: ${compactText(readiness?.nextAction || "retry the unchanged saved decision to finish its pending derived state update.", 240)}`,
    );
  } else if (value?.status === "awaiting_review" && readiness?.runConflict) {
    lines.push(
      "Change impact review is waiting for the current Run boundary.",
      "User decision: none for this impact set now.",
      `Next: ${compactText(readiness.nextAction || "finish the current Run or its pending review, then inspect impact readiness again.", 240)}`,
    );
  } else if (value?.status === "awaiting_review" && readiness && !readiness.acceptanceAvailable) {
    lines.push("Change impact evidence changed after the proposal.", "Acceptance is unavailable for this outdated candidate set.");
    if (readiness.explicitRejectionAvailable) {
      lines.push("Available action: explicitly reject this exact outdated set, then record fresh change evidence.");
    } else {
      lines.push(`Next: ${compactText(readiness.nextAction || "inspect the structured readiness state before taking action.", 240)}`);
    }
  } else if (value?.status === "awaiting_review") {
    lines.push(
      "Change impacts need your review.",
      `Subject: ${candidates.length} evidence-linked impact candidates`,
      "Options: accept all, accept a selection, or reject.",
      "Recommendation: none is generated mechanically; Lode assesses the exact evidence.",
      "Reply in natural language. Lode will verify the unchanged candidate set before applying the decision.",
    );
  } else if (value?.status === "awaiting_evidence") {
    lines.push("No reviewed Product mapping supports an impact candidate yet.", "User decision: none now. Lode may gather exact evidence when the task needs it.");
  } else if (value?.status === "reviewed") {
    lines.push("Change impacts have an explicit review.", "Next: use the reviewed impact facts when relevant.");
  } else if (value?.status === "rejected") {
    lines.push("The exact Change impact candidate set was rejected.", "Next: record fresh change evidence only if later work requires it.");
  } else {
    lines.push(`ChangeSet: ${value?.status || "not started"}.`, `Next: ${compactText(value?.nextAction || "record one only after an accepted execution change needs reviewed lineage.")}`);
  }
  lines.push("", "Product Canon and recovery direction are unchanged; technical IDs remain in the structured result.");
  return `${lines.join("\n")}\n`;
}

export function formatPendingReview(value) {
  const review = value?.review || {};
  const plan = review.wholePlan || {};
  const result = review.resultPacket || {};
  const options = review.reviewProtocol?.allowedDispositions || [];
  return `${[
    "A durable Run result needs Fresh Lode review.",
    "",
    `Objective: ${compactText(plan.objective || "not recorded", 240)}`,
    `Result: ${compactText(result.summary || result.status || "evidence packet ready", 240)}`,
    `Verification evidence: ${Array.isArray(result.verification) ? result.verification.length : Array.isArray(result.evidence) ? result.evidence.length : 0} item(s)`,
    `Options: ${options.length ? options.join(", ") : "accept, revise, expand, rollback, or escalate"}`,
    "",
    "Worker or ResultPacket completion is not acceptance. Review the evidence and reply with the intended disposition.",
    "Technical IDs remain in the structured result.",
  ].join("\n")}\n`;
}

export function formatConformanceQueue(value) {
  const findings = value?.findings || [];
  const lines = [
    `Conformance review queue: ${value?.totalMatches || 0} finding(s).`,
    "Ordinary work is not blocked by this queue.",
  ];
  for (const finding of findings.slice(0, 5)) {
    lines.push(`  - [${finding.status || "open"}] ${compactText(finding.claim?.summary || "finding", 160)}${finding.latestDisposition?.actor ? ` (${finding.latestDisposition.actor})` : ""}`);
  }
  if ((value?.omitted || 0) > 0) lines.push(`  - ${value.omitted} more finding(s) available on the next bounded page`);
  lines.push("", "A finding is evidence, not a violation or decision. Inspect one exact finding before disposition.", "Technical IDs remain in the structured result.");
  return `${lines.join("\n")}\n`;
}

export function formatConformanceFinding(value) {
  const finding = value?.finding || {};
  return `${[
    "One Conformance finding is ready for review.",
    "",
    `Subject: ${compactText(finding.claim?.summary || "conformance finding", 200)}`,
    `Risk hint: ${finding.claim?.riskHint || "unknown"}`,
    `Evidence anchors: ${Array.isArray(finding.evidenceAnchors) ? finding.evidenceAnchors.length : 0}`,
    `Resolution candidates: ${Array.isArray(value?.resolutions) ? value.resolutions.length : 0}`,
    "Options: acknowledge, defer, dismiss, request a code fix, request Canon revision, or accept an exact resolution.",
    "",
    "Lode may acknowledge or defer this evidence without a user response. Ask the user only for dismissal, resolution acceptance, or new direction; re-read the exact finding first.",
    `Latest disposition author: ${value?.latestDisposition?.actor || "none"}.`,
    "This finding neither blocks ordinary work nor authorizes a fix by itself.",
  ].join("\n")}\n`;
}

export function formatReviewOutcome(value) {
  const disposition = value?.reviewDecision?.disposition || value?.disposition?.disposition || "recorded";
  const headMaintenance = ["head-maintenance-evidence-not-user-decision-or-execution-authority", "lode-maintenance-evidence-not-user-decision-or-execution-authority"].includes(value?.disposition?.authority);
  const authorityChanged = value?.authorityEffect === "explicit-product-canon-transition";
  const graphDeferred = value?.productGraph?.status === "deferred";
  const graphReason = /^[A-Z][A-Z0-9_:-]{0,127}$/.test(value?.productGraph?.reasonCode || "")
    ? value.productGraph.reasonCode : "PRODUCT_OPERATING_PROJECTION_FAILED";
  const savedDecisionId = /^[a-z-]+-[a-f0-9]{24}$/.test(value?.reviewDecision?.reviewDecisionId || "")
    ? value.reviewDecision.reviewDecisionId : "decision";
  return `${[
    headMaintenance ? "Lode evidence maintenance was recorded; no user decision was claimed or requested." : "The explicit user decision was recorded.",
    "",
    `Disposition: ${disposition}`,
    `Product Canon changed: ${authorityChanged ? "yes, through the scoped ReviewDecision" : "no"}`,
    "Verification: the Core accepted the exact current target and structured decision.",
    ...(graphDeferred ? [`Saved ${savedDecisionId}; derived graph update deferred (${graphReason}).`] : []),
    headMaintenance ? "The finding remains evidence, not resolved or approved; ordinary work can continue." : "Remaining uncertainty: semantic correctness remains subject to the user's decision and cited evidence.",
    "",
    "Technical IDs remain in the structured result.",
  ].join("\n")}\n`;
}

export function formatContextPreparation(value) {
  const preparation = value?.preparation || {};
  const lines = [
    "Lode Context: selected evidence is ready for Lode assessment.",
    "User action: none. Lode inspects original sources and expands useful evidence as needed.",
  ];
  if (preparation.remainingUncertainty?.length) lines.push(`Remaining uncertainty: ${preparation.remainingUncertainty.join(" ")}`);
  lines.push("No authority or recovery state changed.", "", "Technical details: rerun with --json");
  return `${lines.join("\n")}\n`;
}
export function formatContextPreview(value) {
  const capsule = value?.capsule || {};
  const workflow = value?.workflow || {};
  const budget = workflow.budget || capsule.budget || {};
  const lines = [
    "Lode Context preview: selected evidence is ready for Lode assessment.",
    `Budget: ${formatBudget(budget.usedApproxTokens)} used of ${formatBudget(budget.requestedApproxTokens || budget.maxApproxTokens)} approximate tokens`,
  ];
  const explanation = workflow.explanation;
  if (explanation) {
    lines.push(`Included: ${explanation.included.totalCandidateCount} evidence item(s)`);
    if (explanation.intentionallyOmitted.total) {
      const reasons = Object.entries(explanation.intentionallyOmitted.byReason).map(([reason, count]) => `${reason} ${count}`).join(", ");
      lines.push(`Omitted: ${explanation.intentionallyOmitted.total} (${reasons})`);
    }
    if (explanation.remainingUncertainty.length) lines.push(`Remaining uncertainty: ${explanation.remainingUncertainty.join(" ")}`);
  }
  if (capsule.evidenceGaps?.length) lines.push(`Evidence gaps: ${capsule.evidenceGaps.length}; Lode inspects or expands relevant sources.`);
  lines.push("User action: none. Lode judges relevance and sufficiency; no inclusion-proof gate.",
    "This preview changed no project state and granted no authority.", "", "Technical details: rerun with --json");
  return `${lines.join("\n")}\n`;
}
export function formatCheckpointBasis(value) {
  const basis = value?.basis || {};
  const availability = value?.syncAvailability || "unknown";
  const lines = [
    availability === "ready"
      ? "Lode recovery basis: current and ready for a fresh Lode direction."
      : `Lode recovery basis: ${availability}.`,
    `Basis: ${basis.basisId || "unavailable"}`,
    "User action: none. This read changed no checkpoint or authority.",
  ];
  if (availability !== "ready") lines.push("Next: Lode handles the exact transition before retrying checkpoint sync; ordinary independent work remains available.");
  lines.push("", "Technical details: rerun with --json");
  return `${lines.join("\n")}\n`;
}

export function formatCheckpointDiagnosis(value) {
  const diagnosis = value?.diagnosis || {};
  const checkpoint = value?.currentCheckpoint || {};
  const recovery = value?.artifactRecovery || {};
  const update = value?.checkpointUpdate || {};
  const consistency = value?.observationConsistency || {};
  const titles = {
    "no-current-checkpoint": "Lode checkpoint diagnosis: no current checkpoint.",
    "verified-checkpoint": "Lode checkpoint diagnosis: artifact recovery verified.",
    "verified-checkpoint-with-missing-result-evidence": "Lode checkpoint diagnosis: recovery verified; optional result evidence is missing.",
    "current-checkpoint-artifact-missing": "Lode checkpoint diagnosis: the pointed checkpoint artifact is missing.",
    "required-recovery-artifact-missing": "Lode checkpoint diagnosis: a required recovery artifact is missing.",
    "checkpoint-integrity-failure": "Lode checkpoint diagnosis: recovery artifact integrity failed.",
    "checkpoint-reference-drift": "Lode checkpoint diagnosis: checkpoint references do not match current lineage.",
    "observation-changed-retry": "Lode checkpoint diagnosis: state changed during this read.",
    "core-drift": "Lode checkpoint diagnosis: Core readiness needs attention.",
    "verification-failed": "Lode checkpoint diagnosis: verification did not complete.",
  };
  const lines = [titles[diagnosis.state] || `Lode checkpoint diagnosis: ${diagnosis.state || "unknown"}.`];
  lines.push(`Checkpoint pointer: ${checkpoint.checkpointId || "none"}`);
  lines.push(`Artifact recovery: ${recovery.status || "unknown"}`);
  lines.push(`Checkpoint update: ${update.status || "unknown"}`);
  if (diagnosis.reasonCode && !new Set(["NO_CURRENT_CHECKPOINT", "CHECKPOINT_ARTIFACT_RECOVERY_VERIFIED"]).has(diagnosis.reasonCode)) {
    lines.push(`Reason: ${diagnosis.reasonCode}`);
  }
  if (consistency.retryRequired) lines.push("Observed state was not a stable atomic snapshot; Lode must retry this read before checkpoint-dependent action.");
  lines.push("Semantic freshness: not mechanically determined. This read did not invoke another Lode assessment.");
  const nextAction = value?.nextLodeAction ?? value?.nextHeadAction;
  if (nextAction?.summary) lines.push(`Next: ${nextAction.summary}`);
  lines.push("User action: none. Ordinary independent work remains available.");
  lines.push("This diagnosis wrote no checkpoint, lock, cache, approval, or authority.", "", "Technical details: rerun with --json");
  return `${lines.join("\n")}\n`;
}

export function formatCheckpointSync(value) {
  const outcome = value?.outcome || "unknown";
  const checkpointId = value?.checkpoint?.checkpointId || null;
  const title = {
    created: "Lode recovery checkpoint: synchronized.",
    reused: "Lode recovery checkpoint: already current; no write was needed.",
    deferred: "Lode recovery checkpoint: deferred while an exact transition is recovered.",
    conflict: "Lode recovery checkpoint: stale or conflicting direction was not written.",
  }[outcome] || `Lode recovery checkpoint: ${outcome}.`;
  const lines = [title];
  if (checkpointId) lines.push(`Checkpoint: ${checkpointId}`);
  if (value?.reasonCode) lines.push(`Reason: ${value.reasonCode}`);
  lines.push(`Writes: ledger ${value?.writes?.checkpointLedger ?? 0}, Session pointer ${value?.writes?.sessionPointer ?? 0}`);
  lines.push("User action: none. Ordinary independent work remains available.");
  if (value?.retryGuidance) lines.push(`Next: ${value.retryGuidance}`);
  if (value?.workEvidence) lines.push(`Optional work evidence: ${value.workEvidence.status}${value.workEvidence.reasonCode ? " (" + value.workEvidence.reasonCode + ")" : ""}. P2 outcome above is separate; do not replay completed effects.`);
  lines.push("", "Technical details: rerun with --json");
  return `${lines.join("\n")}\n`;
}

export function formatDeliveryStatus(value) {
  if (value?.status === "not_started") {
    return "Lode delivery evidence: none recorded for this selection. Ordinary work remains available.\n";
  }
  const lines = [`Lode delivery evidence: ${value?.environments?.length || 0} environment(s), ${value?.targets?.length || 0} artifact-target history set(s).`];
  for (const environment of (value?.environments || []).slice(0, 10)) {
    const targetDetails = (value.targets || []).filter((target) => target.environmentKey === environment.environmentKey);
    const revisions = [...new Set(targetDetails.filter((target) => target.current).map((target) => `${target.artifactKey}@${target.current.revisionKey}`))].sort();
    const suffix = revisions.length ? ` — ${revisions.join(", ")}` : "";
    lines.push(`${environment.environmentKey}: ${environment.state} across ${environment.observedTargetCount} observed target(s) and ${environment.observedArtifactTargetCount} artifact-target history set(s)${suffix}`);
    for (const target of targetDetails.filter((item) => item.state === "unknown" || ["failed", "cancelled"].includes(item.lastAttempt?.outcome)).slice(0, 10)) {
      const current = target.current ? `${target.artifactKey}@${target.current.revisionKey}` : "unknown";
      const attempt = target.lastAttempt ? `; last attempt ${target.lastAttempt.outcome}` : "";
      const issue = target.ordering?.issues?.[0]?.code ? `; order ${target.ordering.issues[0].code}` : "";
      lines.push(`  ${target.targetKey}/${target.artifactKey}: current ${current}${attempt}${issue}`);
    }
  }
  if ((value?.environments?.length || 0) > 10) lines.push(`Environments omitted from this card: ${value.environments.length - 10}`);
  if (value?.history?.omitted) lines.push(`History omitted: ${value.history.omitted}; increase history_limit or use --history-limit when needed.`);
  lines.push("Scope: observed targets only; completeness and unobserved target success are not inferred.");
  return `${lines.join("\n")}\n`;
}

function formatSessionList(value) {
  if (!originalObject(value) || !Array.isArray(value.sessions)) return JSON.stringify(value);
  const handled = new Set(["sessions"]);
  let text = "Logical Sessions: purpose and stored P2 pointers; not freshly verified execution or completion.\n";
  text += originalFacts(value, ["projectId", "defaultSessionId"], "sessions", handled);
  for (const [index, session] of value.sessions.entries()) {
    text += `Session[${index}]:\n`;
    if (!originalObject(session)) { text += originalField(`sessions[${index}]`, session); continue; }
    const fields = new Set();
    text += originalFacts(session, ["purpose", "sessionId", "default"], `sessions[${index}]`, fields);
    if (originalObject(session.state)) {
      const state = session.state, stateFields = new Set(); fields.add("state");
      for (const [key, shown] of [["purpose", session.purpose], ["sessionId", session.sessionId], ["projectId", value.projectId]]) {
        if (Object.hasOwn(state, key) && isDeepStrictEqual(state[key], shown)) stateFields.add(key);
      }
      text += value.preview?.sessionId === session.sessionId
        ? "Stored pointers only; the requested exact work preview follows with its own coverage/errors.\n"
        : "Stored pointers only; recent work and remaining tasks are uninspected until an exact preview.\n";
      text += originalFacts(state, ["updatedAt", "activeRunId", "pendingReview", "requiredPlanAction", "latestCheckpoint"], `sessions[${index}].state`, stateFields);
      text += originalRemainder(state, stateFields, `sessions[${index}].state`);
    }
    if (value.preview?.sessionId !== session.sessionId) text += `Preview this Session with the existing list session_id / --session ${JSON.stringify(session.sessionId)}; no selection change.\n`;
    text += originalRemainder(session, fields, `sessions[${index}]`);
  }
  if (!value.sessions.length) text += originalField("sessions", value.sessions);
  if (originalObject(value.preview)) {
    handled.add("preview");
    const preview = value.preview;
    text += `Read-only Session preview ${JSON.stringify(preview.sessionId)}: ${preview.status}. Current selection is unchanged.\n`;
    const fields = new Set(["workContext"]);
    text += originalFacts(preview, ["currentProjectDirection", "currentProjectDirectionAvailability", "conclusion", "inputProvenance"], "preview", fields);
    text += formatSessionWorkContext(preview.workContext);
    text += originalRemainder(preview, fields, "preview");
  }
  if (originalObject(value.conversationDiscovery)) {
    handled.add("conversationDiscovery");
    const discovery = value.conversationDiscovery, fields = new Set(["rows"]);
    text += "Stored conversation lookup: mappings in the current operational store; no live activity, contact, work participation or owner assignment is established.\n";
    text += originalFacts(discovery, ["status", "readAt", "coverage", "interpretation"], "conversationDiscovery", fields);
    for (const row of discovery.rows || []) {
      const rowFields = new Set();
      text += originalFacts(row, ["index", "selector", "status", "binding", "matchesRequestedSession", "reasonCode"], "conversationCandidate", rowFields);
      for (const key of ["activity", "contactReadiness", "workParticipation", "ownerAssignment", "modelUse"])
        if (row[key] === "unknown") rowFields.add(key);
      text += originalRemainder(row, rowFields, "conversationCandidate");
    }
    text += originalRemainder(discovery, fields, "conversationDiscovery");
  }
  return text + originalRemainder(value, handled, "sessions");
}

function formatPreparedRuntimeRead(value) {
  if (!originalObject(value?.preparedInput)) return `${JSON.stringify(value, null, 2)}\n`;
  let text = "Historical prepared input: preparation, runtime observation and model use are separate. Current cancellation and execution guards still apply.\n";
  const handled = new Set(["authorization", "preparedInput"]), authorization = value.authorization;
  text += originalFacts(value, ["status", "file"], "runtimeRead", handled);
  if (originalObject(authorization)) {
    text += originalFacts(authorization, ["authorizationId", "authorizationHash", "projectId", "headSessionId", "lodeSessionId", "runtime", "scope"], "authorization", new Set());
    if (authorization.workerInput) text += originalFacts(authorization.workerInput, ["taskKey", "role", "outcome"], "preparedWorker", new Set());
  }
  const viewFields = new Set(["excerpt"]), view = value.preparedInput;
  text += originalFacts(view, ["status", "reasonCode", "expectedInput", "inputProof", "originals", "delivery", "modelUse", "interpretation"], "preparedInput", viewFields);
  if (originalObject(view.excerpt)) {
    const excerptFields = new Set(["text"]);
    text += originalFacts(view.excerpt, ["startByte", "endByte", "totalBytes", "omittedBytes"], "preparedInput.excerpt", excerptFields);
    text += terminalBlock("Verified canonical input excerpt", view.excerpt.text);
    text += originalRemainder(view.excerpt, excerptFields, "preparedInput.excerpt");
  }
  text += originalRemainder(view, viewFields, "preparedInput");
  text += originalRemainder(value, handled, "runtimeRead");
  return text + "Full original authorization remains in the structured result / --json; prepared input grants no new permission.\n";
}

function formatGraphInventory(value) {
  if (value?.inventoryPage?.kind !== "untyped-owned-byte-observations") return null;
  const page = value.inventoryPage, lines = [`Owned record discovery: ${page.coverage.status} (${page.rows.length} byte observations).`,
    "Bytes are untyped evidence; kind, review state, currentness and authority were not verified."];
  const json = entry => inertTerminalText(JSON.stringify(entry));
  for (const row of page.rows) lines.push(`${inertTerminalText(row.path)} — ${row.byteObservation}${row.reasonCode ? ` (${inertTerminalText(row.reasonCode)})` : ""}${row.digest ? ` sha256:${row.digest}` : ""}`,
    row.exactRead.supported ? `Read: ${json(row.exactRead)}` : `Typed read unavailable: ${inertTerminalText(row.exactRead.scope)}`);
  for (const warning of page.warnings) lines.push(`Uninspected: ${inertTerminalText(warning.path)} (${inertTerminalText(warning.reasonCode)})`);
  if (page.next) lines.push(`Next: ${json(page.next)}`);
  if (page.narrowing.length) lines.push(`Narrow scope: ${json(page.narrowing)}`);
  lines.push("No automatic retries. Earlier insertions and previous page currentness remain unknown; ordinary work continues.");
  return lines.join("\n") + "\n";
}

export function formatMcpToolContent(name, value) {
  name = resolveOperation(name)?.semanticName ?? name;
  if (name === "head_session_list") return formatSessionList(value);
  if (["head_runtime_invocation_authorization", "head_bounded_worker_status"].includes(name)) return formatPreparedRuntimeRead(value);
  if (name === "head_project_graph") return formatGraphInventory(value) ?? formatTerminalGraph(value) ?? JSON.stringify(value);
  if (name === "head_bounded_worker_prepare") return formatWorkerPreparation(value);
  if (["head_worker_integration_status", "head_worker_integration"].includes(name)) return formatWorkerGuidance(value);
  if (["head_bounded_worker_wave_status", "head_bounded_worker_wave_wait"].includes(name)) return formatWorkerGuidance(value);
  if (name === "head_source_context") return formatSourceContext(value);
  if (name === "head_project_status") return formatProjectStatus(value);
  if (name === "head_project_initialize_or_resume") return formatProjectBootstrap(value);
  if (name === "head_session_restore") return formatSessionRestore(value);
  if (["head_conversation_enter", "head_compaction_lifecycle_step"].includes(name)) return formatConversationRecovery(value);
  if (name === "head_onboarding_guide") return formatOnboardingGuide(value);
  if (name === "head_feature_mapping_status") return formatFeatureMappingStatus(value);
  if (name === "head_change_set_status") return formatChangeSetStatus(value);
  if (name === "head_delivery_status") return formatDeliveryStatus(value);
  if (name === "head_pending_review") return formatPendingReview(value);
  if (name === "head_conformance_queue") return formatConformanceQueue(value);
  if (name === "head_conformance_read") return formatConformanceFinding(value);
  if (["head_onboarding_review", "head_feature_mapping_review", "head_conformance_disposition", "head_product_initiative_review"].includes(name)) return formatReviewOutcome(value);
  if (name === "head_context_prepare") return formatContextPreparation(value);
  if (name === "head_context_preview") return formatContextPreview(value);
  if (name === "head_checkpoint_basis") return formatCheckpointBasis(value);
  if (name === "head_checkpoint_diagnose") return formatCheckpointDiagnosis(value);
  if (name === "head_checkpoint_sync") return formatCheckpointSync(value);
  if (name === "head_session_work_record") return formatSessionWorkRecord(value);
  if (name === "head_session_work_read") return value?.status === "session_selection_unresolved" ? formatUnavailableSession(value) : formatSessionWorkContext(value) || "No selected Session work evidence is recorded. Ordinary work continues.\n";
  return JSON.stringify(value);
}

export function formatCliError(error) {
  return "Lode could not complete that step.\n"
    + terminalBlock("Reason", error?.message || "Unknown error")
    + terminalBlock("Code", error?.code || "HEAD_CLI_ERROR")
    + "Failure is not proof of state change or approval. Details: --json\n";
}

export function formatCliResult(command, value, presentation = {}) {
  if (command === "session-list") return formatSessionList(value);
  if (command === "runtime-invocation-read") return formatPreparedRuntimeRead(value);
  if (value?.status === "session_selection_unresolved") return formatUnavailableSession(value, { doctor: command === "doctor" });
  if (command === "worker-prepare") return formatWorkerPreparation(value);
  if (["worker-integration-status", "worker-integrate", "worker-wave-status", "worker-wave-wait"].includes(command)) return formatWorkerGuidance(value);
  if (command === "source-context") return formatSourceContext(value);
  if (command === "graph-query") return formatGraphInventory(value) ?? formatTerminalGraph(value, presentation) ?? terminalBlock("Unrecognized graph result", JSON.stringify(value, null, 2));
  if (["help", "--help", "-h", "help-all"].includes(command)) return formatHelp(value);
  if (command === "status" || command === "doctor") return formatProjectStatus(value, { doctor: command === "doctor" });
  if (command === "init" || command === "resume") return formatProjectBootstrap(value);
  if (command === "session-restore") return formatSessionRestore(value);
  if (["conversation-enter", "compaction-lifecycle-step"].includes(command)) return formatConversationRecovery(value);
  if (command === "feature-mapping-status") return formatFeatureMappingStatus(value);
  if (command === "change-set-status") return formatChangeSetStatus(value);
  if (command === "delivery-status") return formatDeliveryStatus(value);
  if (command === "run-review-context") return formatPendingReview(value);
  if (command === "conformance-queue") return formatConformanceQueue(value);
  if (command === "conformance-read") return formatConformanceFinding(value);
  if (["onboarding-review", "feature-mapping-review", "change-impact-review", "run-review", "conformance-disposition", "product-initiative-review"].includes(command)) return formatReviewOutcome(value);
  if (command === "context-prepare") return formatContextPreparation(value);
  if (command === "context-preview") return formatContextPreview(value);
  if (command === "checkpoint-basis") return formatCheckpointBasis(value);
  if (command === "checkpoint-diagnose") return formatCheckpointDiagnosis(value);
  if (command === "checkpoint-sync") return formatCheckpointSync(value);
  if (command === "session-work-record") return formatSessionWorkRecord(value);
  if (command === "session-work-read") return formatSessionWorkContext(value) || "No selected Session work evidence is recorded. Ordinary work continues.\n";
  if (["world-index", "world-status", "world-refresh", "world-refresh-status", "world-refresh-read", "world-docs-build", "world-docs-status", "world-docs-capture", "world-docs-candidates"].includes(command)) return formatWorldSummary(command, value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatWorldSummary(command, value) {
  const documents = command.startsWith("world-docs-"), snapshot = value?.snapshot;
  const projection = value?.projection?.projection || value?.projection || {};
  const candidate = value?.candidateSet;
  const postRefresh = value?.postRefreshProjection, postOutcome = postRefresh?.receipt?.outcome;
  const changes = value?.receipt?.observedChanges || value?.changes;
  const sourceLabel = value?.receipt?.observedChanges ? "Recorded refresh source" : "Source";
  const lines = [`${documents ? "World documents" : "World"}: ${compactText(inertTerminalText(value?.status || "status not returned"))}.`];
  const fact = (label, content) => { if (content != null && content !== "") lines.push(terminalBlock(label, content).trimEnd()); };
  fact("World snapshot", snapshot?.worldModelId || value?.worldModelId || value?.worldModel?.worldModelId || value?.currentWorldModelId);
  fact("World freshness", value?.worldModelStatus || (command === "world-status" ? value?.status : null));
  fact("Graph snapshot", snapshot?.temporalProvenanceGraph?.graphSnapshotId || value?.graphSnapshotId || value?.worldModel?.graphSnapshotId);
  const counts = snapshot?.summary || projection.summary;
  if (counts) {
    const entries = Object.entries(counts).filter(([, count]) => Number.isSafeInteger(count) && count >= 0);
    fact("Counts", entries.slice(0, 16).map(([key, count]) => `${key}: ${count}`).join("; "));
    if (entries.length > 16) fact("Omitted count fields", entries.length - 16);
  }
  for (const key of ["added", "changed", "removed"]) if (Array.isArray(changes?.[key])) {
    const paths = changes[key];
    fact(`${sourceLabel} ${key}`, `${paths.length}${paths.length ? `; ${paths.slice(0, 6).map(item => compactText(inertTerminalText(typeof item === "string" ? item : item.path), 160)).join("; ")}` : ""}${paths.length > 6 ? `; ${paths.length - 6} more in --json` : ""}`);
  }
  const flags = Object.entries(value?.changes || {}).filter(([, changed]) => changed === true).map(([key]) => key);
  if (flags.length) fact("Changed domains", flags.join("; "));
  fact("Document projection", value?.documentProjectionId || projection.documentProjectionId || postOutcome?.documentProjectionId);
  const locations = value?.projection?.publishedLocations || projection.publishedLocations;
  if (Array.isArray(locations)) {
    fact("Published document paths", `${locations.length}; ${locations.slice(0, 3).map(item => compactText(inertTerminalText(item.relativePath || item.location), 180)).join("; ")}${locations.length > 3 ? `; ${locations.length - 3} more in --json` : ""}`);
  }
  const drift = value?.projection?.drift || projection.drift;
  if (Array.isArray(drift)) fact("Document differences", `${drift.length}${drift.length ? `; ${drift.slice(0, 6).map(item => `${compactText(inertTerminalText(item.relativePath), 160)} (${compactText(inertTerminalText(item.changeType), 40)})`).join("; ")}` : ""}${drift.length > 6 ? `; ${drift.length - 6} more in --json` : ""}`);
  fact("Candidate set", candidate?.candidateSetId || postOutcome?.candidateSetId);
  if (Array.isArray(candidate?.candidates)) fact("Unreviewed document candidates", candidate.candidates.length);
  if (value?.projection?.candidateRequired || projection.candidateRequired || candidate?.requiresReviewDecision || postOutcome?.status === "blocked-edited-view") lines.push("Document changes need their existing review before Canon application; independent work continues.");
  fact("Refresh receipt", value?.receipt?.refreshReceiptId || value?.pointer?.refreshReceiptId);
  fact("Post-refresh documents", postRefresh?.status);
  fact("Post-refresh document reason", postOutcome?.reasonCode || postRefresh?.reasonCode);
  if (["refreshed", "unchanged"].includes(value?.receipt?.status) && (postRefresh?.status === "failed" || postRefresh?.status?.startsWith("blocked-"))) lines.push("World refresh remains recorded; this document outcome does not roll it back. Independent work continues.");
  if (/^document-change-candidate-set-[a-f0-9]{24}$/u.test(postOutcome?.candidateSetId || "")) lines.push(`Read document candidates: lode-agent world-docs-candidates "<project>" --candidate-set "${postOutcome.candidateSetId}" --json`);
  fact("Evidence gap", value?.reasonCode);
  fact("Saved result", value?.receiptFile || value?.file || value?.projection?.projectionLocation || projection.projectionLocation);
  fact("Saved post-refresh result", postRefresh?.receiptFile);
  lines.push("Derived evidence only; counts do not prove semantic sufficiency, approval or execution success.");
  const mutating = ["world-index", "world-refresh", "world-docs-build", "world-docs-capture"].includes(command);
  if (mutating) lines.push("Raw output is available with --json on the original command; do not repeat a mutation solely to inspect details. Read-only checks: world-status / world-docs-status --json.");
  else {
    const id = command === "world-docs-candidates" ? candidate?.candidateSetId : command === "world-refresh-read" ? value?.receipt?.refreshReceiptId : null;
    const argument = id && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id) ? ` ${command === "world-docs-candidates" ? "--candidate-set" : "--receipt"} "${id}"` : "";
    lines.push(id && !argument ? "Full original result: add --json to the original command with its exact arguments."
      : `Full original result: lode-agent ${command} "<project>"${argument} --json`);
  }
  return `${lines.join("\n")}\n`;
}

function formatWorkerPreparation(value) {
  if (value?.status !== "unavailable_for_selected_scope") return `${JSON.stringify(value, null, 2)}\n`;
  return [
    "Managed worker not prepared: selected-only input conflicts with existing CLI global instructions.",
    "This limits this optional preparation, not Lode or the entire provider backend. No model or account call was made by this preparation.",
    value.guidance.nextStep,
    value.guidance.scopeChange,
    "No authorization or automatic fallback is supplied by this guidance. Technical details: --json", "",
  ].join("\n");
}

function formatWorkerGuidance(value) {
  const view = value?.projection || value?.application || value;
  const guidance = view?.guidance;
  if (!guidance) return `${JSON.stringify(value, null, 2)}\n`;
  const counts = view.counts;
  const lines = [counts ? `Worker group: ${view.state}; ${counts.started}/${counts.requested} started, ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.waiting} waiting.`
    : `Worker integration: ${view.status}; Lode action: ${guidance.action}.`];
  for (const entry of (guidance.unavailable || []).slice(0, 8)) lines.push(`${compactText(entry.path, 160)} (${entry.role}): ${compactText(entry.reason, 120)}`);
  if (guidance.unavailable?.length > 8) lines.push(`${guidance.unavailable.length - 8} additional dependency issues in structured details.`);
  lines.push(guidance.nextStep);
  if (counts) lines.push("Group state and wait completion do not prove worker process cleanup.");
  lines.push("Unrelated ordinary work remains available. No routine user approval is added.", "Technical details: --json");
  return `${lines.join("\n")}\n`;
}

function formatSourceContext(value) {
  if (["head-selection-needed", "lode-selection-needed"].includes(value.status)) return `${value.nextAction}\n`;
  const ready = value.results.filter((item) => item.status === "ready" && item.includedInContext);
  const lines = [`Source context: ${ready.length}/${value.results.length} selected needs included.`];
  for (const item of value.results) lines.push(`${item.need.path}${item.need.symbol ? ` :: ${item.need.symbol}` : ""}: ${item.status}${item.reused ? " (reused; current bytes verified)" : ""}${item.code ? ` — ${item.code}` : ""}${item.unresolvedCount ? `; ${item.unresolvedCount} unresolved calls` : ""}`);
  if (value.pendingNeeds.length) lines.push("Only judgments depending on missing required evidence need attention; independent work can continue.");
  if (value.retentionPending?.length) lines.push("Some requested retention is unavailable: verified evidence remains usable, but durable handoff is not confirmed.");
  if (value.results.some((item) => item.storageIssues?.length)) lines.push("Stored-evidence issues are listed in the result; damaged originals were not overwritten or deleted.");
  lines.push("Partial source observations, not runtime truth or semantic sufficiency. Lode assesses what the task still needs.");
  return `${lines.join("\n")}\n`;
}

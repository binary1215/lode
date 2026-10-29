import { withSnapshotReferencesAsync } from "./snapshot-reference-lifetime.mjs";
import { inspectProject } from "./lode-core.mjs";
import { publicToolName } from "./lode-artifact-composition.mjs";
import { loadObservationArtifacts } from "./observation-store.mjs";
import { previewContextWorkflow } from "./context-workflow.mjs";
import { artifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { readSourceBytes, sourceCurrent, sourceDigest, sourceObjectDigest, sourceError, collectorImplementation,
  runPythonSourceWorker, preparePythonObservation, preparePythonDeclarations, validateDeclarationSelection, PYTHON_DECLARATION_KINDS, compactDeclarationProfile } from "./python-source-collector.mjs";
import { SOURCE_OBSERVATION_TYPE, DECLARATION_OBSERVATION_TYPE, createSourceObservation, verifySourceObservation, retainSourceObservation, readSourceObservation, retainSourceFailure, readSourceFailure, classifySourceStorageError } from "./source-observation.mjs";

const recent = new Map(); // P5 bounded optimization only; never a recovery pointer.
let recentBytes = 0;
function remember(key, bundle) {
  if (recent.has(key)) recentBytes -= recent.get(key).bytes;
  const bytes = Buffer.byteLength(JSON.stringify(bundle));
  recent.set(key, { bundle, bytes }); recentBytes += bytes;
  while (recent.size > 64 || recentBytes > 16 * 1024 * 1024) {
    const oldest = recent.keys().next().value;
    recentBytes -= recent.get(oldest).bytes; recent.delete(oldest);
  }
}
const unavailable = new Set(["PYTHON_NOT_CONFIGURED", "SOURCE_PROCESS_FAILED", "SOURCE_TIMEOUT", "SOURCE_CANCELLED", "SOURCE_BYTE_LIMIT", "SOURCE_RESPONSE_LIMIT", "SOURCE_SYMLINK_UNSUPPORTED", "SOURCE_NOT_REGULAR_FILE", "ENOENT", "EACCES", "SOURCE_DRIFT", "SOURCE_ENCODING_UNSUPPORTED", "SOURCE_LANGUAGE_UNSUPPORTED"]);
const cacheKey = (root, query, sources, profile, kind) => sourceObjectDigest({ root, query, sources: sources.map(({ path, digest }) => ({ path, digest })), profile, kind });

function normalizeNeeds(needs) {
  if (!Array.isArray(needs) || needs.length > 32) throw sourceError("SOURCE_NEEDS_INVALID");
  return needs.map((need, index) => {
    if (!need || Object.keys(need).some((key) => !["kind", "path", "symbol", "required", "selection"].includes(key))
      || !["source", "outgoing-calls", ...PYTHON_DECLARATION_KINDS].includes(need.kind) || typeof need.path !== "string"
      || (need.required !== undefined && typeof need.required !== "boolean")
      || (need.symbol !== undefined && (typeof need.symbol !== "string" || need.symbol.length > 512))
      || (["outgoing-calls", "selected-source"].includes(need.kind) && !need.symbol)
      || (need.selection !== undefined && need.kind !== "selected-source")
      || (need.kind === "declarations" && need.symbol)) throw sourceError("SOURCE_NEEDS_INVALID");
    if (need.selection !== undefined) validateDeclarationSelection(need.selection);
    return { id: `source-need-${index + 1}`, kind: need.kind, path: need.path, symbol: need.symbol ?? "", required: need.required ?? true,
      ...(need.selection === undefined ? {} : { selection: need.selection }) };
  });
}

async function prepareSourceContextUnderLifetime({ root = ".", task, needs = [], retain = false, budget,
  signal, timeoutMs = 15_000, onProcess } = {}) {
  if (typeof task !== "string" || !task.trim()) throw sourceError("TASK_REQUIRED");
  const normalized = normalizeNeeds(needs);
  if (!normalized.length) return { kind: "SourceContextResult", status: "head-selection-needed", task,
    authorityBoundary: artifactAuthorityBoundary("SourceContextResult"), instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false, mutatesCanon: false,
    headActionRequired: true, userActionRequired: false,
    nextAction: `Lode: inspect task-relevant files, select exact source paths and qualified Python function names, then call ${publicToolName("head_source_context")} with needs. Do not ask the user for JSON, IDs, hashes or another request.`,
    supportedCollector: "parse-only Python stdlib AST; positive lexical direct-name candidates; not LSP or runtime call truth" };
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") throw sourceError("PROJECT_NOT_READY");
  root = inspected.project.projectRoot;
  const projectId = inspected.project.projectId;
  const results = [], selected = [];
  let identity;
  for (const need of normalized) {
    let sources, query, profile, response;
    const storageIssues = [];
    const storageIssue = (error, reference) => {
      const status = classifySourceStorageError(error);
      if (!status) throw error;
      storageIssues.push({ reference, status, code: error.code });
    };
    const saveFailure = (input) => {
      if (!retain) return null;
      try { return retainSourceFailure(root, input, inspected.storage); }
      catch (error) { storageIssue(error, "failure-retention"); return null; }
    };
    try {
      if (signal?.aborted) throw sourceError("SOURCE_CANCELLED");
      const bytes = readSourceBytes(root, need.path);
      sources = [{ path: need.path, digest: sourceDigest(bytes), base64: bytes.toString("base64") }];
      const declarationNeed = PYTHON_DECLARATION_KINDS.includes(need.kind);
      query = [{ path: need.path, symbol: need.symbol, ...(declarationNeed ? { kind: need.kind, ...(need.selection ? { selection: need.selection } : {}) } : {}) }];
      if (bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) throw sourceError("SOURCE_ENCODING_UNSUPPORTED");
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw sourceError("SOURCE_ENCODING_UNSUPPORTED"); }
      if (/\r(?!\n)/u.test(text)) throw sourceError("SOURCE_ENCODING_UNSUPPORTED");
      if (need.kind !== "source") {
        if (!need.path.endsWith(".py")) throw sourceError("SOURCE_LANGUAGE_UNSUPPORTED");
        identity ??= await runPythonSourceWorker({ operation: "identity" }, { signal, timeoutMs, onProcess });
        profile = { runtime: identity.result.profile, executableDigest: identity.executableDigest, implementation: collectorImplementation() };
      } else profile = { reader: "exact-utf8-source-1", implementation: collectorImplementation() };
      const key = cacheKey(root, query, sources, profile, need.kind);
      let bundle = recent.get(key)?.bundle, reused = false;
      if (bundle) {
        try {
          verifySourceObservation(root, projectId, bundle, { storage: inspected.storage });
          if (retain) {
            try { readSourceObservation(root, projectId, bundle.observation.payload.bundleKey, { storage: inspected.storage }); }
            catch (error) { if (error.code !== "ENOENT") throw error; /* safe create-only retention from verified memory */ }
          }
        } catch (error) {
          storageIssue(error, bundle.observation?.payload?.bundleKey ?? "memory-cache");
          recentBytes -= recent.get(key).bytes; recent.delete(key); bundle = null;
        }
      }
      if (!bundle && retain) {
        // Only explicitly retained observations can promise restart rediscovery.
        let observations = [];
        try { observations = loadObservationArtifacts({ projectRoot: root, projectId, storage: inspected.storage }).observations; }
        catch (error) { storageIssue(error, "observation-index"); }
        for (const record of observations.filter((entry) => entry.typeKey === (declarationNeed ? DECLARATION_OBSERVATION_TYPE : SOURCE_OBSERVATION_TYPE)
          && entry.payload.path === need.path && entry.payload.evidenceKind === need.kind && entry.payload.sourceDigest === sources[0].digest)) {
          try {
            const previous = readSourceObservation(root, projectId, record.payload.bundleKey, { storage: inspected.storage });
            if (cacheKey(root, previous.evidence.query, previous.evidence.sources, previous.evidence.profile, previous.evidence.kind) === key) { bundle = previous; break; }
          } catch (error) { storageIssue(error, record.payload.bundleKey); }
        }
      }
      if (bundle) { verifySourceObservation(root, projectId, bundle, { storage: inspected.storage }); reused = true; }
      else {
        let prepared = null;
        if (need.kind !== "source") {
          response = await runPythonSourceWorker({ operation: declarationNeed ? "declarations" : "collect", sources: [{ ...query[0], text }] }, { signal, timeoutMs, onProcess });
          if (response.result.reason === "output-frame-limit") throw sourceError("SOURCE_RESPONSE_LIMIT");
          if (sourceObjectDigest(response.result.profile) !== sourceObjectDigest(profile.runtime) || response.executableDigest !== profile.executableDigest
            || sourceObjectDigest(collectorImplementation()) !== sourceObjectDigest(profile.implementation)) throw sourceError("SOURCE_DRIFT");
          prepared = (declarationNeed ? preparePythonDeclarations : preparePythonObservation)({ projectId, query, sources, response, profile });
          if (prepared.status !== "ready") {
            if (!sourceCurrent(root, sources)) throw sourceError("SOURCE_DRIFT");
            const failureKey = saveFailure({ projectId, query, sources, profile, response: response.raw.toString("base64"), status: prepared.status, code: prepared.code });
            results.push({ need, status: prepared.status, code: prepared.code, reason: response.result.results[0].reason ?? prepared.reason,
              unresolved: response.result.results[0].unresolved, sourceDigest: sources[0].digest,
              ...(declarationNeed ? { collectionProfile: prepared.details.collectionProfile, declarations: prepared.details.declarations, total: prepared.details.total, omitted: prepared.details.omitted,
                selectedSourceBytes: prepared.details.selectedSourceBytes ?? null } : {}),
              failureKey, retained: Boolean(failureKey), storageIssues,
              scope: "this-need-only", fallback: "HEAD may inspect current source separately or reselect an exact declaration; missing evidence does not block independent work" });
            continue;
          }
        }
        if (signal?.aborted) throw sourceError("SOURCE_CANCELLED");
        if (!sourceCurrent(root, sources)) throw sourceError("SOURCE_DRIFT");
        bundle = createSourceObservation({ version: declarationNeed ? 2 : 1, projectId, kind: need.kind, query, sources, profile,
          observedAt: new Date().toISOString(), response: response?.raw.toString("base64") ?? null, envelopeHash: prepared?.evidenceHash ?? prepared?.envelope?.envelopeHash ?? null }, inspected.storage);
        verifySourceObservation(root, projectId, bundle, { storage: inspected.storage });
      }
      let retained = false;
      if (retain) {
        try { retainSourceObservation(root, bundle, inspected.storage); retained = true; }
        catch (error) { storageIssue(error, bundle.observation.payload.bundleKey); }
      }
      remember(key, bundle);
      selected.push({ need, bundle });
      results.push({ need, status: "ready", reused, observationId: bundle.observation.observationId,
        ...(declarationNeed ? { declarationStatus: JSON.parse(bundle.observation.payload.details).status, omittedDeclarations: JSON.parse(bundle.observation.payload.details).omitted } : {}),
        retained, bundleKey: retained ? bundle.observation.payload.bundleKey : null, storageIssues,
        coverage: "partial", truth: "unknown", sourceDigest: sources[0].digest,
        unresolvedCount: bundle.observation.payload.unresolvedCount, omittedSourceBytes: bundle.observation.payload.omittedSourceBytes });
    } catch (error) {
      if (!unavailable.has(error.code) && !["SOURCE_RESPONSE_INVALID", "SOURCE_OBSERVATION_INVALID", "SOURCE_PATH_INVALID", "INVALID_OBSERVATION_PAYLOAD", "SOURCE_STORAGE_CONFLICT", "SOURCE_STORAGE_UNSAFE"].includes(error.code)) throw error;
      const status = unavailable.has(error.code) ? "unavailable" : "invalid";
      const failureKey = saveFailure({ projectId, query: query ?? [{ path: need.path, symbol: need.symbol }], sources: sources ?? [], profile: profile ?? null,
        response: response?.raw.toString("base64") ?? null, status, code: error.code });
      results.push({ need, status, code: error.code, diagnostic: error.diagnostic ?? null, failureKey, retained: Boolean(failureKey), storageIssues, scope: "this-need-only", sourceDigest: sources?.[0]?.digest ?? null,
        ...(PYTHON_DECLARATION_KINDS.includes(need.kind) && profile?.runtime ? { collectionProfile: compactDeclarationProfile(profile) } : {}) });
    }
  }
  // Revalidate at the consumption boundary, not merely after collection.
  const current = [];
  for (const item of selected) {
    try { verifySourceObservation(root, projectId, item.bundle, { storage: inspected.storage }); current.push(item); }
    catch (error) {
      const classification = classifySourceStorageError(error);
      if (!classification) throw error;
      const result = results.find((entry) => entry.need.id === item.need.id);
      Object.assign(result, { status: classification, code: error.code });
      delete result.observationId;
    }
  }
  const evidenceNeeds = current.map(({ need, bundle }) => ({ id: need.id, kind: "observation", observationIds: [bundle.observation.observationId], rationale: `HEAD-selected ${need.kind}; source-linked context for HEAD assessment` }));
  const context = current.length ? (await previewContextWorkflow({ root, task, budget, evidenceNeeds, sourceObservations: current.map(({ bundle }) => bundle), includeRepositoryWorld: false })) : null;
  const included = new Set(context?.capsule.observationEvidence.map((entry) => entry.nodeId) ?? []);
  for (const result of results) if (result.status === "ready") result.includedInContext = included.has(result.observationId);
  const pendingNeeds = results.filter((entry) => entry.status !== "ready" || !entry.includedInContext);
  const retentionPending = retain ? results.filter((entry) => !entry.retained).map((entry) => entry.need.id) : [];
  return { kind: "SourceContextResult", status: pendingNeeds.length || retentionPending.length ? "partial" : "observed", task,
    authorityBoundary: artifactAuthorityBoundary("SourceContextResult"), instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false, mutatesCanon: false,
    results, pendingNeeds: pendingNeeds.map(({ need, status, code }) => ({ ...need, status, code: code ?? "CONTEXT_NOT_INCLUDED" })), context,
    retentionPending, headActionRequired: pendingNeeds.some((entry) => entry.need.required) || retentionPending.length > 0, userActionRequired: false,
    decisionScope: "hold-only-judgments-dependent-on-missing-required-evidence; independent-work-unaffected",
    semanticSufficiency: "HEAD-assessment-required", contextScope: "current-Core-instructions-and-HEAD-selected-source-observations; no-World-scan-or-full-index-required",
    authority: { observation: "P3", failureRecord: "P3", resultWrapper: "P4", capsule: "P2-typed-preview-not-persisted-or-bound", processAndCache: "P5", canon: "unchanged", recovery: "unchanged" },
    retention: retain ? "create-only-source-bundles-and-common-observations; revalidate-on-read" : "ephemeral; no-durable-resume-claim" };
}

export function inspectSourceObservation({ root = ".", bundleKey, failureKey } = {}) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") throw sourceError("PROJECT_NOT_READY");
  if (Boolean(bundleKey) === Boolean(failureKey)) throw sourceError("SOURCE_EXACT_REFERENCE_REQUIRED");
  if (failureKey) return readSourceFailure(inspected.project.projectRoot, inspected.project.projectId, failureKey, inspected.storage);
  const bundle = readSourceObservation(inspected.project.projectRoot, inspected.project.projectId, bundleKey, { requireCurrent: false, storage: inspected.storage });
  let sourceState;
  try { sourceState = sourceCurrent(inspected.project.projectRoot, bundle.evidence.sources) ? "current-source-bytes" : "stale"; }
  catch (error) { if (!classifySourceStorageError(error)) throw error; sourceState = "unavailable"; }
  return { status: sourceState === "current-source-bytes" ? sourceState : "historical", sourceState,
    currentContextEligible: sourceState === "current-source-bytes", observation: bundle.observation, evidence: bundle.evidence,
    truth: "unknown", collectionProfile: "historical; new collection checks installed collector profile" };
}

export async function prepareSourceContext(options = {}) {
  return options.retain ? withSnapshotReferencesAsync({root:options.root ?? "."},()=>prepareSourceContextUnderLifetime(options)) : prepareSourceContextUnderLifetime(options);
}

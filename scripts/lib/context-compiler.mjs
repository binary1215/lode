import crypto from "node:crypto";
import { SOURCE_OBSERVATION_TYPE, DECLARATION_OBSERVATION_TYPE, sourceObservationNode, readSourceObservation } from "./source-observation.mjs";
import fs from "node:fs";
import path from "node:path";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import { formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";
import { queryGraphProjection } from "./graph-projection-adapter.mjs";
import { inspectWorldDomainFreshness, buildWorldTraversalEligibility } from "./world-model.mjs";
import { loadObservationProjection } from "./observation-projection.mjs";
import { readProjectDirection } from "./project-direction.mjs";

export const CONTEXT_COMPILER_VERSION = "0.23.0";
import { CONTEXT_BUDGET_PROTOCOL_VERSION, DEFAULT_CONTEXT_BUDGET } from "./context-budget.mjs";
export { CONTEXT_BUDGET_PROTOCOL_VERSION, DEFAULT_CONTEXT_BUDGET };
export const EVIDENCE_NEED_KINDS = Object.freeze([
  "claim",
  "decision",
  "git-decision",
  "observation",
  "product-context",
  "repository-file",
  "repository-source",
  "repository-test",
  "runtime-state",
  "semantic-relation",
  "temporal-relation",
  "unknown",
]);
const MAX_REPOSITORY_GRAPH_EXPANSIONS = 32;
const MAX_CONTEXT_SYMBOLS_PER_FILE = 12;
const MAX_CONTEXT_DEPENDENCIES_PER_FILE = 12;
const MAX_CONTEXT_RELATIONSHIPS_PER_FILE = 4;
const MAX_PRODUCT_CONTEXT_ENTITIES = 24;
const MAX_PRODUCT_CONTEXT_RELATIONSHIPS = 48;
const PRODUCT_ENTITY_KINDS = new Set(["FeatureGroup", "Capability", "Feature", "Requirement", "Constraint", "Decision", "Policy"]);

const STOP_WORDS = new Set([
  "the", "is", "are", "was", "were", "a", "an", "and", "or", "for", "from", "with", "into", "this", "that",
  "what", "why", "how", "when", "where", "will", "would", "should", "could", "task", "current",
  "현재", "이번", "관련", "위한", "무엇", "어떻게", "왜", "언제", "에서", "으로", "이다", "있다",
]);
const KOREAN_PARTICLES = ["으로", "에서", "에게", "까지", "부터", "처럼", "하고", "하며", "하면", "한다", "하고자", "만들고자", "을", "를", "은", "는", "이", "가", "과", "와", "의", "로", "도", "만"];

const fail = (message, code = "CONTEXT_COMPILER_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const approxTokens = (value) => Math.ceil(String(value).length / 4);

function normalizeContextBudget(value) {
  const maxApproxTokens = Number(value);
  if (!Number.isSafeInteger(maxApproxTokens) || maxApproxTokens < 1) {
    fail("Context budget must be a positive safe integer.", "INVALID_CONTEXT_BUDGET");
  }
  return {
    maxApproxTokens,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_CONTEXT_CANON"); }
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function normalizedLexicalText(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/https?:\/\/[^\s)>\]}]+/giu, " ")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .replace(/[_./\\:@-]+/g, " ")
    .toLocaleLowerCase();
}

function terms(value) {
  const result = new Set();
  const originalIdentifiers = String(value).normalize("NFKC").replace(/https?:\/\/[^\s)>\]}]+/giu, " ").toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  for (const token of new Set([...originalIdentifiers, ...(normalizedLexicalText(value).match(/[\p{L}\p{N}]{2,}/gu) || [])])) {
    if (!STOP_WORDS.has(token)) result.add(token);
    if (!/[\p{Script=Hangul}]/u.test(token)) continue;
    for (const particle of KOREAN_PARTICLES) {
      if (token.length > particle.length + 1 && token.endsWith(particle)) {
        const stem = token.slice(0, -particle.length);
        if (!STOP_WORDS.has(stem)) result.add(stem);
        break;
      }
    }
  }
  return result;
}

function overlap(left, right) {
  let count = 0;
  for (const item of left) if (right.has(item)) count += 1;
  return count;
}

function matchedTerms(left, right) {
  return [...left].filter((item) => right.has(item)).sort();
}

function rankBounded(items, taskTerms, body, limit) {
  return items.map((item, index) => ({
    item,
    index,
    relevance: overlap(taskTerms, terms(body(item))),
  })).sort((left, right) => right.relevance - left.relevance || left.index - right.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

function compactList(values, limit = 12) {
  const items = Array.isArray(values) ? values : [];
  return {
    count: items.length,
    sample: items.slice(0, limit),
    omitted: Math.max(0, items.length - limit),
    digest: digest(canonicalJson(items)),
  };
}

function compactTraversalMetadata(traversal) {
  if (!traversal) return null;
  const query = traversal.traversalQuery || {};
  const inclusion = Array.isArray(traversal.inclusion) ? traversal.inclusion : [];
  const inclusionReasons = {};
  for (const item of inclusion) inclusionReasons[item.reason || "included"] = (inclusionReasons[item.reason || "included"] || 0) + 1;
  return {
    graphSnapshotId: traversal.graphSnapshotId,
    graphSnapshotHash: traversal.graphSnapshotHash,
    sourceSnapshotId: traversal.sourceSnapshotId,
    queryId: traversal.queryId,
    queryHash: traversal.queryHash,
    resultId: traversal.resultId,
    resultHash: traversal.resultHash,
    traversalQuerySummary: {
      anchorMode: query.anchorMode,
      normalizedQuery: query.normalizedQuery,
      anchorIds: compactList(query.anchorIds),
      expectedGraphSnapshotId: query.expectedGraphSnapshotId,
      allowedKinds: compactList(query.allowedKinds),
      allowedRelations: query.allowedRelations || [],
      allowedAuthorityClasses: query.allowedAuthorityClasses || [],
      allowedFreshness: query.allowedFreshness || [],
      minConfidence: query.minConfidence,
      includeUnreviewedCandidates: query.includeUnreviewedCandidates,
      maxDepth: query.maxDepth,
      maxNodes: query.maxNodes,
      maxEdges: query.maxEdges,
      ordering: query.ordering,
    },
    inclusionSummary: {
      count: inclusion.length,
      reasons: Object.fromEntries(Object.entries(inclusionReasons).sort()),
      sample: inclusion.slice(0, 8),
      digest: digest(canonicalJson(inclusion)),
    },
    exclusion: traversal.exclusion,
    boundary: traversal.boundary ? {
      items: compactList(traversal.boundary.items, 12),
      nextAnchorIds: compactList(traversal.boundary.nextAnchorIds, 12),
      omittedItemCount: traversal.boundary.omittedItemCount,
      complete: traversal.boundary.complete,
    } : null,
    truncated: traversal.truncated,
  };
}

function historyRelevance(task) {
  const value = task.toLocaleLowerCase();
  if (/(history|historical|과거|언제부터|회귀|evolution)/u.test(value)) return "DEEP";
  if (/(why|왜|decision|결정|architecture|architectural|설계)/u.test(value)) return "DECISIONS";
  if (/(recent|최근|변경|changed|regression)/u.test(value)) return "RECENT";
  return "NONE";
}

function validateId(value, kind) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(value)) {
    fail(`${kind} has an invalid id.`, "INVALID_KNOWLEDGE_ID");
  }
}

function validateKnowledge(value) {
  if (value?.schemaVersion !== SCHEMA_VERSION) fail("Knowledge canon schema is incompatible.", "INVALID_KNOWLEDGE_SCHEMA");
  for (const key of ["evidence", "claims", "decisions", "unknowns"]) {
    if (!Array.isArray(value[key])) fail(`Knowledge canon ${key} must be an array.`, "INVALID_KNOWLEDGE_SCHEMA");
    for (const item of value[key]) validateId(item?.id, key);
  }
  const ids = new Set();
  for (const key of ["evidence", "claims", "decisions", "unknowns"]) for (const item of value[key]) {
    if (ids.has(item.id)) fail(`Knowledge id is duplicated: ${item.id}`, "DUPLICATE_KNOWLEDGE_ID");
    ids.add(item.id);
  }
  return value;
}

async function loadSources(root, includeRepositoryWorld = true, worldDomains = null, storage = null) {
  const files = {
    project: path.join(root, relativeProjectArtifact(storage, "project.json")),
    projectContext: path.join(root, relativeProjectArtifact(storage, "instructions", "project.md")),
    knowledge: path.join(root, relativeProjectArtifact(storage, "context", "knowledge.json")),
    managedManifest: path.join(root, relativeProjectArtifact(storage, "generated", "manifest.json")),
  };
  for (const [name, file] of Object.entries(files)) if (!fs.existsSync(file)) {
    fail(`Context source is missing: ${name}`, "MISSING_CONTEXT_SOURCE");
  }
  const raw = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.readFileSync(file, "utf8")]));
  let worldModel = null;
  try { if (includeRepositoryWorld) worldModel = (await inspectWorldDomainFreshness({ root, storage, ...(worldDomains ? { domains: worldDomains } : {}) })); }
  catch (error) { worldModel = { status: "unavailable", reasonCode: error.code || "WORLD_EVIDENCE_UNAVAILABLE" }; }
  const direction = readProjectDirection({ root, storage });
  if (direction) raw.projectDirection = canonicalJson(direction);
  return { files, raw, knowledge: validateKnowledge(JSON.parse(raw.knowledge)), worldModel, direction };
}

function contextSnapshot(inspected, sources) {
  const sourceDigests = Object.fromEntries(Object.entries(sources.raw).map(([name, value]) => [name, digest(value)]));
  if (sources.worldModel?.snapshot) sourceDigests.repositoryWorldModel = sources.worldModel.snapshot.worldModelHash;
  let coverage = "curated-head-canon-only";
  if (sources.worldModel?.snapshot) {
    const hasGitHistory = sources.worldModel.snapshot.gitDecisionHistory?.coverage === "all-reachable-commits";
    const layers = ["curated-head-canon", hasGitHistory ? "repository-world-model-semantic" : "repository-world-model-semantic-alpha"];
    if (sources.worldModel.snapshot.temporalProvenanceGraph) layers.push("temporal-provenance-alpha");
    if (domainCurrent(sources.worldModel, "product")) layers.push("product-canon-projection-alpha");
    if (hasGitHistory && domainCurrent(sources.worldModel, "git")) layers.push("git-history-alpha");
    if (domainCurrent(sources.worldModel, "runtime") && sources.worldModel.snapshot.externalRuntimeState?.coverage === "point-in-time-host-export") layers.push("external-runtime-state-alpha");
    if (!domainCurrent(sources.worldModel, "code")) layers.splice(1, 1, "repository-code-evidence-excluded");
    coverage = layers.join("+");
  }
  const identity = {
    schemaVersion: SCHEMA_VERSION,
    projectId: inspected.project.projectId,
    projectRoot: inspected.project.projectRoot,
    sourceDigests,
    coverage,
  };
  return {
    kind: "Snapshot",
    ...identity,
    snapshotId: `snapshot-${digest(canonicalJson(identity)).slice(0, 24)}`,
  };
}

export async function buildContextSnapshot(root = ".") {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready to build a context snapshot; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  const sources = (await loadSources(inspected.project.projectRoot, true, null, inspected.storage));
  return contextSnapshot(inspected, sources);
}

function evidenceIndex(knowledge) {
  return new Map(knowledge.evidence.map((item) => [item.id, {
    kind: "Evidence",
    id: item.id,
    sourceKind: item.sourceKind || "project-artifact",
    uri: item.uri || "",
    digest: item.digest || "",
    summary: item.summary || "",
    observedAt: item.observedAt || "",
    instructionAuthority: false,
  }]));
}

function itemCandidate(kind, item, taskTerms, evidenceById, historyClass) {
  const body = kind === "Claim"
    ? item.statement
    : kind === "Decision"
      ? [item.title, item.decision, item.reason, ...(item.constraints || [])].filter(Boolean).join(" ")
      : item.statement;
  const tags = Array.isArray(item.tags) ? item.tags.map(String) : [];
  const candidateTerms = terms(`${body} ${tags.join(" ")}`);
  const matches = matchedTerms(taskTerms, candidateTerms);
  const relevance = matches.length;
  const importance = Number.isFinite(Number(item.importance)) ? Math.max(0, Math.min(5, Number(item.importance))) : 1;
  const historyBoost = kind === "Decision" && ["DECISIONS", "DEEP"].includes(historyClass) ? 20 : 0;
  const unknownBoost = kind === "Unknown" && importance >= 5 ? 12 : 0;
  const score = relevance * 25 + importance * 4 + historyBoost + unknownBoost;
  const evidence = (item.evidenceIds || []).map((id) => evidenceById.get(id)).filter(Boolean);
  const record = {
    kind,
    ...item,
    evidence,
    trustBoundary: kind === "Decision" ? "promoted-project-decision" : "evidence-not-instruction",
  };
  return { id: item.id, kind, score, relevance, matchedTerms: matches, importance, approxTokens: approxTokens(canonicalJson(record)), record };
}

function activeCandidates(knowledge, task, historyClass) {
  const taskTerms = terms(task);
  const evidenceById = evidenceIndex(knowledge);
  const candidates = [];
  for (const item of knowledge.claims) {
    if ((item.status || "active") === "active") candidates.push(itemCandidate("Claim", item, taskTerms, evidenceById, historyClass));
  }
  for (const item of knowledge.decisions) {
    if (!new Set(["superseded", "stale", "rejected"]).has(item.status)) candidates.push(itemCandidate("Decision", item, taskTerms, evidenceById, historyClass));
  }
  for (const item of knowledge.unknowns) {
    if ((item.status || "open") === "open") candidates.push(itemCandidate("Unknown", item, taskTerms, evidenceById, historyClass));
  }
  return candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function domainCurrent(worldModel, domain) { return worldModel?.freshness?.domains?.[domain]?.status === "current"; }
async function queryTemporalProjection(worldModel, graphProjectionAdapter, query) {
  const graph = worldModel.snapshot.temporalProvenanceGraph;
  const eligibility = buildWorldTraversalEligibility(worldModel.snapshot, worldModel.freshness.domains);
  const needsMask = eligibility.nodeIds.length !== graph.nodes.length || eligibility.edgeIds.length !== graph.edges.length;
  return (await queryGraphProjection({
    projectRoot: worldModel.storage.projectRoot,
    storage: worldModel.storage,
    graph: worldModel.snapshot.temporalProvenanceGraph,
    adapter: graphProjectionAdapter,
    query: { ...query, ...(needsMask ? { eligibility } : {}) },
  })).result;
}

function relationEndpointPaths(relation) {
  return [...new Set([
    ...(relation.endpointPaths || []),
    relation.from?.path,
    relation.to?.path,
    relation.evidence?.path,
  ].filter((value) => typeof value === "string" && value).map((value) => value.replaceAll("\\", "/")))].sort();
}

function relationMatchesNeed(relation, need, carrierPath = "") {
  const relationType = String(relation.type || "").toUpperCase();
  if (need.relationTypes.length && !need.relationTypes.includes(relationType)) return false;
  if (need.paths.length && !relationEndpointPaths(relation).some((item) => need.paths.includes(item))) return false;
  return facetMatch(facetContentText([carrierPath, relationFacetValues(relation)]), need.facets);
}

function repositoryCandidates(worldModel, task, budget = DEFAULT_CONTEXT_BUDGET, needs = []) {
  if (!domainCurrent(worldModel, "code")) return [];
  const taskTerms = terms(task);
  const graph = worldModel.snapshot.semanticGraph || null;
  const nodes = new Map((graph?.nodes || []).map((node) => [node.id, node]));
  const nodeReference = (node) => node ? {
    id: node.id,
    kind: node.kind,
    path: node.path,
    name: node.name,
    specifier: node.specifier,
    symbolKind: node.symbolKind,
    line: node.line,
  } : null;
  const relationshipEdgesByPath = new Map();
  for (const edge of graph?.edges || []) {
    const relation = {
      id: edge.id,
      type: edge.type,
      from: nodeReference(nodes.get(edge.from)),
      to: nodeReference(nodes.get(edge.to)),
      evidence: edge.evidence,
      confidence: edge.confidence,
      specifier: edge.specifier,
      callee: edge.callee,
      trustBoundary: "evidence-not-instruction",
    };
    relation.endpointPaths = relationEndpointPaths(relation);
    for (const filePath of relation.endpointPaths) {
      if (!relationshipEdgesByPath.has(filePath)) relationshipEdgesByPath.set(filePath, []);
      relationshipEdgesByPath.get(filePath).push(relation);
    }
  }
  const ranked = worldModel.snapshot.files.map((file) => {
    const lightweightBody = [
      file.path,
      file.classification,
      file.language,
      ...file.symbols.map((item) => `${item.kind} ${item.name}`),
      ...file.dependencies.map((item) => `${item.kind} ${item.specifier}`),
    ].join(" ");
    const matches = matchedTerms(taskTerms, terms(lightweightBody));
    const pathMatches = matchedTerms(taskTerms, terms(file.path));
    const relevance = matches.length;
    const importance = ["source", "test"].includes(file.classification) ? 3 : 1;
    return {
      file,
      relevance,
      matchedTerms: matches,
      pathMatchedTerms: pathMatches,
      importance,
      score: relevance * 25 + pathMatches.length * 10 + importance * 4,
    };
  }).sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  const expansionLimit = Math.min(MAX_REPOSITORY_GRAPH_EXPANSIONS, Math.max(8, Math.ceil(Number(budget) / 4000) * 8));
  const relevantRanked = ranked.filter((item) => item.relevance > 0);
  const seedLimit = Math.max(4, Math.ceil(expansionLimit / 2));
  const expandedPaths = new Set(relevantRanked.slice(0, seedLimit).map((item) => item.file.path));
  for (const seed of relevantRanked.slice(0, seedLimit)) {
    if (expandedPaths.size >= expansionLimit) break;
    const neighbors = (relationshipEdgesByPath.get(seed.file.path) || []).flatMap((edge) => edge.endpointPaths)
      .filter((filePath) => filePath && filePath !== seed.file.path)
      .sort();
    for (const filePath of neighbors) {
      expandedPaths.add(filePath);
      if (expandedPaths.size >= expansionLimit) break;
    }
  }
  for (const item of relevantRanked) {
    if (expandedPaths.size >= expansionLimit) break;
    expandedPaths.add(item.file.path);
  }
  const relationNeeds = needs.filter((need) => need.kind === "semantic-relation");
  return ranked.map(({ file, relevance: lightweightRelevance, matchedTerms: lightweightMatches, pathMatchedTerms, importance, score: lightweightScore }) => {
    const expanded = expandedPaths.has(file.path);
    const allRelationships = relationshipEdgesByPath.get(file.path) || [];
    const relationBody = (item) => [
      item.type,
      item.from?.path,
      item.from?.name,
      item.to?.path,
      item.to?.name,
      item.to?.specifier,
    ].filter(Boolean).join(" ");
    // Discovery limits must not make HEAD-requested evidence ineligible.
    // Each need reserves its explicit minimum; the shared Capsule budget still
    // controls packing, and every remaining adjacency is counted as omitted.
    const requiredRelationships = relationNeeds.flatMap((need) => rankBounded(
      allRelationships.filter((relation) => relationMatchesNeed(relation, need, file.path)),
      taskTerms, relationBody, need.minimumItems,
    ));
    const relationshipsById = new Map(requiredRelationships.map((relation) => [relation.id, relation]));
    if (expanded) {
      for (const relation of rankBounded(allRelationships, taskTerms, relationBody, MAX_CONTEXT_RELATIONSHIPS_PER_FILE)) {
        if (relationshipsById.size >= Math.max(MAX_CONTEXT_RELATIONSHIPS_PER_FILE, requiredRelationships.length)) break;
        relationshipsById.set(relation.id, relation);
      }
    }
    const relationships = [...relationshipsById.values()];
    const body = [
      file.path,
      file.classification,
      file.language,
      ...file.symbols.map((item) => `${item.kind} ${item.name}`),
      ...file.dependencies.map((item) => `${item.kind} ${item.specifier}`),
      ...relationships.flatMap((item) => [item.type, item.from?.path, item.from?.name, item.to?.path, item.to?.name, item.to?.specifier]).filter(Boolean),
    ].join(" ");
    const matches = expanded ? matchedTerms(taskTerms, terms(body)) : lightweightMatches;
    const relevance = matches.length;
    const score = expanded ? relevance * 25 + pathMatchedTerms.length * 10 + importance * 4 : lightweightScore;
    const symbols = rankBounded(file.symbols, taskTerms, (item) => `${item.kind} ${item.name}`, MAX_CONTEXT_SYMBOLS_PER_FILE);
    const dependencies = rankBounded(file.dependencies, taskTerms, (item) => `${item.kind} ${item.specifier}`, MAX_CONTEXT_DEPENDENCIES_PER_FILE);
    const record = {
      kind: "RepositoryFile",
      path: file.path,
      digest: file.digest,
      freshness: file.freshness,
      classification: file.classification,
      language: file.language,
      representation: {
        kind: "repository-metadata",
        sourceBodyIncluded: false,
        sourceBodyConsumptionVerified: false,
      },
      symbols,
      dependencies,
      semanticRelationships: relationships,
      evidenceOmissions: {
        symbols: Math.max(0, file.symbols.length - symbols.length),
        dependencies: Math.max(0, file.dependencies.length - dependencies.length),
        semanticRelationships: Math.max(0, allRelationships.length - relationships.length),
      },
      semanticGraphId: graph?.semanticGraphId || null,
      graphExpansion: requiredRelationships.length ? "head-evidence-need-adjacency" : expanded ? "bounded-semantic-adjacency" : "not-expanded-by-discovery-bound",
      worldModelId: worldModel.snapshot.worldModelId,
      trustBoundary: "evidence-not-instruction",
    };
    return {
      id: `repository-file:${file.path}`,
      kind: "RepositoryFile",
      score,
      relevance,
      matchedTerms: matches,
      directMatchedTerms: lightweightMatches,
      pathMatchedTerms,
      importance,
      approxTokens: approxTokens(canonicalJson(record)),
      record,
    };
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

async function productContextCandidates(worldModel, task, graphProjectionAdapter = null, evidenceNeeds = []) {
  if (!domainCurrent(worldModel, "product")) return [];
  const { temporalProvenanceGraph: graph, productModel } = worldModel.snapshot;
  if (!graph || !productModel) return [];
  const taskTerms = terms(task), needs = evidenceNeeds.filter(need => need.kind === "product-context");
  const currentRevisionIds = new Map(graph.edges.filter(edge => edge.type === "CURRENT_REVISION").map(edge => [edge.from, edge.to]));
  const logical = graph.nodes.filter(node => PRODUCT_ENTITY_KINDS.has(node.kind)
    && node.authorityClass === "canon-projected" && node.freshness === "current");
  const explicit = logical.filter(node => needs.some(need =>
    (!need.entityKeys.length || need.entityKeys.includes(node.key)) &&
    facetMatch(facetContentText(productEntityFacetValues(node)), need.facets)));
  const lexical = rankBounded(logical.filter(node => overlap(taskTerms, terms(facetContentText(productEntityFacetValues(node)))) > 0),
    taskTerms, node => facetContentText(productEntityFacetValues(node)), 12);
  const anchors = [...new Map([...explicit, ...lexical].map(node => [node.nodeId, node])).values()];
  if (!anchors.length) return [];
  // One bounded relation query serves the selected original identities. Missing
  // requested entities/facets remain gaps, rather than triggering another state.
  const traversal = (await queryTemporalProjection(worldModel, graphProjectionAdapter, {
    anchorIds: anchors.slice(0, 32).map(node => node.nodeId), expectedGraphSnapshotId: graph.graphSnapshotId,
    relations: ["CONTAINS", "REALIZES", "GOVERNED_BY", "HAS_REVISION", "CURRENT_REVISION", "PARENT_OF",
      "IMPLEMENTS", "VERIFIED_BY", "IMPACTS", "MATERIALIZED_AS", "REFERENCES", "PROMOTED_FROM", "PRODUCES", "REVIEWED_BY"],
    authorityClasses: ["canon-projected", "reviewed", "derived", "heuristic"], freshness: ["current"],
    includeUnreviewedCandidates: false, depth: 3, maxNodes: 100, maxEdges: 200,
  }));
  const exactIds = new Set(anchors.slice(0, 32).flatMap(node => [node.nodeId, currentRevisionIds.get(node.nodeId)].filter(Boolean)));
  const exactNodes = traversal.nodes.filter(node => exactIds.has(node.nodeId));
  const selectedNodes = [...exactNodes, ...rankBounded(traversal.nodes.filter(node => !exactIds.has(node.nodeId)),
    taskTerms, node => facetContentText(productEntityFacetValues(node)), Math.max(0, MAX_PRODUCT_CONTEXT_ENTITIES - exactNodes.length))];
  const entities = selectedNodes.map(node => ({ ...node,
    logicalEntityId: node.logicalEntityId || (PRODUCT_ENTITY_KINDS.has(node.kind) ? node.nodeId : null),
    currentRevisionId: PRODUCT_ENTITY_KINDS.has(node.kind) ? currentRevisionIds.get(node.nodeId) || null
      : PRODUCT_ENTITY_KINDS.has(node.kind.replace(/Revision$/, "")) ? node.nodeId : null }));
  const selectedIds = new Set(entities.map(node => node.nodeId));
  const relationships = traversal.edges.filter(edge => selectedIds.has(edge.from) && selectedIds.has(edge.to)).slice(0, MAX_PRODUCT_CONTEXT_RELATIONSHIPS);
  const relationshipBoundary = traversal.edges.filter(edge => selectedIds.has(edge.from) !== selectedIds.has(edge.to))
    .map(edge => ({ edgeId: edge.edgeId, type: edge.type, nextAnchorId: selectedIds.has(edge.from) ? edge.to : edge.from }));
  const record = { kind: "ProductContext", projectId: worldModel.snapshot.projectId,
    productModelId: productModel.productModelId, productModelHash: productModel.productModelHash,
    source: worldModel.snapshot.productModelSource, entities, relationships,
    projectionOmissions: { entities: traversal.nodes.length - entities.length, relationships: traversal.edges.length - relationships.length,
      anchoredEntities: Math.max(0, anchors.length - 32), traversalTruncated: Boolean(traversal.truncated), countsScope: "observed-bounded-traversal-only" },
    relationshipBoundary: { items: relationshipBoundary.slice(0, 50), omitted: Math.max(0, relationshipBoundary.length - 50),
      complete: relationshipBoundary.length === 0 && !traversal.truncated }, temporalTraversal: compactTraversalMetadata(traversal),
    worldModelId: worldModel.snapshot.worldModelId, instructionAuthority: false, promotionAuthority: false,
    trustBoundary: "derived-projection-of-user-owned-product-canon" };
  const matches = matchedTerms(taskTerms, terms(facetContentText(entities.map(productEntityFacetValues))));
  return [{ id: `product-context:${traversal.resultId}`, kind: "ProductContext", score: matches.length * 25 + 20,
    relevance: matches.length, matchedTerms: matches, importance: 5,
    approxTokens: approxTokens(canonicalJson(record)), record }];
}

async function graphTraversalCandidates(worldModel, evidenceNeeds, graphProjectionAdapter = null) {
  const anchoredNeeds = evidenceNeeds.filter((need) => need.kind === "temporal-relation" && need.graphAnchor);
  if (!anchoredNeeds.length) return [];
  if (!worldModel?.snapshot) {
    fail("HEAD graph anchors require a current digest-verified World Model.", "GRAPH_ANCHOR_WORLD_MODEL_STALE");
  }
  const snapshot = worldModel.snapshot;
  const graph = snapshot.temporalProvenanceGraph;
  if (!graph) fail("HEAD graph anchors require a current temporal GraphSnapshot.", "GRAPH_ANCHOR_GRAPH_NOT_BUILT");
  return (await Promise.all(anchoredNeeds.map(async (need) => {
    const proposal = need.graphAnchor;
    if (proposal.projectId !== snapshot.projectId) fail(`Evidence need ${need.id} graphAnchor belongs to another Project.`, "GRAPH_ANCHOR_PROJECT_MISMATCH");
    if (proposal.worldModelId !== snapshot.worldModelId) fail(`Evidence need ${need.id} graphAnchor is stale for the current World Model.`, "GRAPH_ANCHOR_WORLD_MODEL_MISMATCH");
    if (proposal.graphSnapshotId !== graph.graphSnapshotId) fail(`Evidence need ${need.id} graphAnchor is stale for the current GraphSnapshot.`, "GRAPH_ANCHOR_GRAPH_SNAPSHOT_MISMATCH");
    const eligibility = buildWorldTraversalEligibility(snapshot, worldModel.freshness.domains);
    if (proposal.nodeIds.some(id => graph.nodes.some(node => node.nodeId === id && node.freshness === "current") && !eligibility.nodeIds.includes(id))) {
      fail(`Evidence need ${need.id} selected an anchor whose domain is not current; independent source discovery remains available.`, "GRAPH_ANCHOR_WORLD_MODEL_STALE");
    }
    const traversal = (await queryTemporalProjection(worldModel, graphProjectionAdapter, {
      anchorIds: proposal.nodeIds,
      expectedGraphSnapshotId: proposal.graphSnapshotId,
      relations: need.relationTypes,
      authorityClasses: ["canon-projected", "reviewed", "derived", "heuristic", "runtime-observed"],
      freshness: ["current"],
      minConfidence: 0,
      includeUnreviewedCandidates: false,
      depth: proposal.depth,
      maxNodes: proposal.maxNodes,
      maxEdges: proposal.maxEdges,
    }));
    const nodePaths = new Map(traversal.nodes.map((node) => [node.nodeId, node.path || null]));
    const relationships = traversal.edges.map((edge) => ({
      ...edge,
      endpointPaths: [...new Set([nodePaths.get(edge.from), nodePaths.get(edge.to)].filter(Boolean))].sort(),
    }));
    const record = {
      kind: "GraphTraversalEvidence",
      evidenceNeedId: need.id,
      graphAnchorProposal: proposal,
      projectId: snapshot.projectId,
      worldModelId: snapshot.worldModelId,
      graphSnapshotId: graph.graphSnapshotId,
      nodes: traversal.nodes,
      relationships,
      temporalTraversal: compactTraversalMetadata(traversal),
      authority: "derived-evidence-only",
      instructionAuthority: false,
      promotionAuthority: false,
      recoveryAuthority: false,
      semanticAcceptance: "HEAD-only",
      trustBoundary: "provider-proposal-validated-as-current-bounded-evidence-not-instruction",
    };
    return {
      id: `graph-traversal-evidence:${need.id}:${traversal.resultId}`,
      kind: "GraphTraversalEvidence",
      score: 100,
      relevance: 0,
      matchedTerms: [],
      importance: 5,
      approxTokens: approxTokens(canonicalJson(record)),
      record,
    };
  }))).sort((left, right) => left.id.localeCompare(right.id));
}

function gitDecisionCandidates(worldModel, task, historyClass) {
  if (!domainCurrent(worldModel, "git") || historyClass === "NONE") return [];
  const history = worldModel.snapshot.gitDecisionHistory;
  if (!history || history.status !== "available") return [];
  const taskTerms = terms(task);
  return history.commits.map((commit, index) => {
    const body = [commit.subject, commit.body, commit.author.name, ...commit.refs].join(" ");
    const matches = matchedTerms(taskTerms, terms(body));
    const relevance = matches.length;
    const importance = commit.parents.length > 1 ? 3 : 2;
    const historyBoost = historyClass === "DEEP" ? 12 : historyClass === "DECISIONS" ? 8 : 0;
    const recencyBoost = historyClass === "RECENT" ? Math.max(0, 20 - index * 4) : 0;
    const score = relevance * 25 + importance * 4 + historyBoost + recencyBoost;
    const record = {
      kind: "GitDecisionEvidence",
      commit: commit.commit,
      parents: commit.parents,
      authoredAt: commit.authoredAt,
      committedAt: commit.committedAt,
      author: commit.author,
      refs: commit.refs,
      subject: commit.subject,
      body: commit.body,
      evidence: commit.evidence,
      historyId: history.historyId,
      instructionAuthority: false,
      trustBoundary: "evidence-not-instruction",
    };
    return {
      id: `git-commit:${commit.commit}`,
      kind: "GitDecisionEvidence",
      score,
      relevance,
      matchedTerms: matches,
      importance,
      approxTokens: approxTokens(canonicalJson(record)),
      record,
    };
  }).sort((left, right) => right.score - left.score
    || right.record.committedAt.localeCompare(left.record.committedAt)
    || left.id.localeCompare(right.id));
}

function runtimeStateCandidates(worldModel, task) {
  if (!domainCurrent(worldModel, "runtime")) return [];
  const runtimeState = worldModel.snapshot.externalRuntimeState;
  if (!runtimeState || runtimeState.status !== "available") return [];
  const taskTerms = terms(task);
  const explicitRuntimes = new Set(runtimeState.summary.runtimes.filter((item) => taskTerms.has(item)));
  const explicitKinds = new Set([...new Set(runtimeState.observations.map((item) => item.kind))].filter((item) => taskTerms.has(item)));
  const explicitStates = new Set([...new Set(runtimeState.observations.map((item) => item.state))].filter((item) => taskTerms.has(item)));
  return runtimeState.observations.filter((observation) => {
    if (explicitRuntimes.size && !explicitRuntimes.has(observation.runtime)) return false;
    if (explicitKinds.size && !explicitKinds.has(observation.kind)) return false;
    if (explicitStates.size && !explicitStates.has(observation.state)) return false;
    return true;
  }).map((observation) => {
    const body = [
      observation.runtime,
      observation.kind,
      observation.state,
      observation.providerVersion,
      ...observation.capabilities,
    ].join(" ");
    const matches = matchedTerms(taskTerms, terms(body));
    const relevance = matches.length;
    const importance = ["failed", "blocked", "active"].includes(observation.state) ? 3 : 2;
    const score = relevance * 25 + importance * 4;
    const record = {
      kind: "RuntimeStateEvidence",
      ...observation,
      runtimeStateId: runtimeState.runtimeStateId,
      instructionAuthority: false,
      controlAuthority: false,
      trustBoundary: "evidence-not-instruction",
    };
    return {
      id: observation.observationId,
      kind: "RuntimeStateEvidence",
      score,
      relevance,
      matchedTerms: matches,
      importance,
      approxTokens: approxTokens(canonicalJson(record)),
      record,
    };
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function observationCandidates(projectRoot, projectId, evidenceNeeds, sourceObservations = [], storage = null) {
  const requestedIds = new Set(evidenceNeeds
    .filter((need) => need.kind === "observation")
    .flatMap((need) => need.observationIds));
  if (!requestedIds.size) return [];
  const suppliedIds = new Set(sourceObservations.map((bundle) => bundle.observation.observationId));
  const projection = [...requestedIds].every((id) => suppliedIds.has(id))
    ? { nodes: [], projectionId: null, projectionHash: null }
    : loadObservationProjection({ projectRoot, projectId, storage });
  const nodes = new Map(projection.nodes.map((node) => [node.nodeId, node]));
  for (const bundle of sourceObservations) {
    const node = sourceObservationNode(projectRoot, projectId, bundle, storage);
    if (nodes.has(node.nodeId) && nodes.get(node.nodeId).observationHash !== node.observationHash) fail("Conflicting source Observation.", "SOURCE_OBSERVATION_INVALID");
    nodes.set(node.nodeId, node);
  }
  return [...nodes.values()]
    .filter((node) => requestedIds.has(node.nodeId) && ["ObservationRecord", "DerivedObservationRecord"].includes(node.kind))
    .map((node) => {
      if ([SOURCE_OBSERVATION_TYPE, DECLARATION_OBSERVATION_TYPE].includes(node.typeKey) && !sourceObservations.some((bundle) => bundle.observation.observationId === node.nodeId)) {
        const verified = sourceObservationNode(projectRoot, projectId, readSourceObservation(projectRoot, projectId, node.payload.bundleKey, { storage }), storage);
        if (verified.observationHash !== node.observationHash) fail("Source Observation binding mismatch.", "SOURCE_OBSERVATION_INVALID");
        node = verified;
      }
      const record = {
        ...node,
        observationProjectionId: node.observationProjectionId ?? projection.projectionId,
        observationProjectionHash: node.observationProjectionHash ?? projection.projectionHash,
        instructionAuthority: false,
        promotionAuthority: false,
        recoveryAuthority: false,
        trustBoundary: "exact-observation-evidence-not-product-meaning-or-instruction",
      };
      return {
        id: node.nodeId,
        kind: "ObservationEvidence",
        score: 100,
        relevance: 0,
        matchedTerms: [],
        importance: 4,
        approxTokens: approxTokens(canonicalJson(record)),
        record,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeEvidenceNeeds(evidenceNeeds) {
  if (evidenceNeeds == null) return [];
  if (!Array.isArray(evidenceNeeds)) fail("HEAD evidence needs must be an array.", "INVALID_EVIDENCE_NEEDS");
  if (evidenceNeeds.length > 32) fail("HEAD evidence needs may contain at most 32 items.", "INVALID_EVIDENCE_NEEDS");
  const allowedKeys = new Set(["id", "kind", "paths", "entityKeys", "observationIds", "facets", "relationTypes", "graphAnchor", "minimumItems", "rationale"]);
  const knownKinds = new Set(EVIDENCE_NEED_KINDS);
  const seen = new Set();
  const normalized = evidenceNeeds.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Evidence need ${index} must be an object.`, "INVALID_EVIDENCE_NEEDS");
    const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length) fail(`Evidence need ${index} has unsupported fields: ${unknownKeys.sort().join(", ")}.`, "INVALID_EVIDENCE_NEEDS");
    const id = String(value.id || "").trim().toLocaleLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) fail(`Evidence need ${index} has an invalid id.`, "INVALID_EVIDENCE_NEEDS");
    if (seen.has(id)) fail(`Evidence need id is duplicated: ${id}.`, "INVALID_EVIDENCE_NEEDS");
    seen.add(id);
    const kind = String(value.kind || "").trim().toLocaleLowerCase();
    if (!knownKinds.has(kind)) fail(`Evidence need ${id} has an unsupported kind: ${kind || "(empty)"}.`, "INVALID_EVIDENCE_NEEDS");
    const rawPaths = value.paths == null ? [] : value.paths;
    if (!Array.isArray(rawPaths) || rawPaths.length > 32 || rawPaths.some((item) => typeof item !== "string" || !item.trim())) {
      fail(`Evidence need ${id} paths must be an array of at most 32 non-empty project-relative paths.`, "INVALID_EVIDENCE_NEEDS");
    }
    const paths = [...new Set(rawPaths.map((item) => item.trim().replace(/\\/g, "/")))].sort();
    if (paths.some((item) => path.posix.isAbsolute(item) || item.split("/").some((part) => !part || part === "." || part === ".."))) {
      fail(`Evidence need ${id} contains a non-normalized project-relative path.`, "INVALID_EVIDENCE_NEEDS");
    }
    if (paths.length && !kind.startsWith("repository-") && !["semantic-relation", "temporal-relation"].includes(kind)) {
      fail(`Evidence need ${id} may use paths only with repository or relation evidence.`, "INVALID_EVIDENCE_NEEDS");
    }
    const rawEntityKeys = value.entityKeys == null ? [] : value.entityKeys;
    if (!Array.isArray(rawEntityKeys) || rawEntityKeys.length > 32 || rawEntityKeys.some((item) => typeof item !== "string" || !item.trim())) {
      fail(`Evidence need ${id} entityKeys must be an array of at most 32 non-empty Product keys.`, "INVALID_EVIDENCE_NEEDS");
    }
    const entityKeys = [...new Set(rawEntityKeys.map((item) => item.trim()))].sort();
    if (entityKeys.some((item) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item))) fail(`Evidence need ${id} contains an invalid Product key.`, "INVALID_EVIDENCE_NEEDS");
    if (entityKeys.length && kind !== "product-context") {
      fail(`Evidence need ${id} may use entityKeys only with product-context evidence.`, "INVALID_EVIDENCE_NEEDS");
    }
    const rawObservationIds = value.observationIds == null ? [] : value.observationIds;
    if (!Array.isArray(rawObservationIds) || rawObservationIds.length > 32 || rawObservationIds.some((item) => typeof item !== "string" || !item.trim())) {
      fail(`Evidence need ${id} observationIds must be an array of at most 32 non-empty Observation ids.`, "INVALID_EVIDENCE_NEEDS");
    }
    const observationIds = [...new Set(rawObservationIds.map((item) => item.trim()))].sort();
    if (observationIds.some((item) => !/^(?:observation|derived-observation)-[a-f0-9]{24}$/.test(item))) {
      fail(`Evidence need ${id} contains an invalid Observation id.`, "INVALID_EVIDENCE_NEEDS");
    }
    if (kind === "observation" && !observationIds.length) {
      fail(`Evidence need ${id} requires at least one exact Observation id.`, "INVALID_EVIDENCE_NEEDS");
    }
    if (kind !== "observation" && observationIds.length) {
      fail(`Evidence need ${id} may use observationIds only with observation evidence.`, "INVALID_EVIDENCE_NEEDS");
    }
    const rawFacets = value.facets == null ? [] : value.facets;
    if (!Array.isArray(rawFacets) || rawFacets.length > 16 || rawFacets.some((item) => typeof item !== "string" || !item.trim())) {
      fail(`Evidence need ${id} facets must be an array of at most 16 non-empty strings.`, "INVALID_EVIDENCE_NEEDS");
    }
    const facets = [...new Set(rawFacets.flatMap((item) => [...terms(item)]))].sort();
    const rawRelations = value.relationTypes == null ? [] : value.relationTypes;
    if (!Array.isArray(rawRelations) || rawRelations.length > 16) fail(`Evidence need ${id} relationTypes must be an array of at most 16 values.`, "INVALID_EVIDENCE_NEEDS");
    const relationTypes = [...new Set(rawRelations.map((item) => String(item).trim().toUpperCase()))].sort();
    if (relationTypes.some((item) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(item))) fail(`Evidence need ${id} has an invalid relation type.`, "INVALID_EVIDENCE_NEEDS");
    if (relationTypes.length && !["semantic-relation", "temporal-relation"].includes(kind)) {
      fail(`Evidence need ${id} may use relationTypes only with a relation kind.`, "INVALID_EVIDENCE_NEEDS");
    }
    let graphAnchor = null;
    if (value.graphAnchor != null) {
      if (kind !== "temporal-relation" || !value.graphAnchor || typeof value.graphAnchor !== "object" || Array.isArray(value.graphAnchor)) {
        fail(`Evidence need ${id} may use graphAnchor only with temporal-relation evidence.`, "INVALID_EVIDENCE_NEEDS");
      }
      const graphAnchorKeys = new Set(["projectId", "worldModelId", "graphSnapshotId", "nodeIds", "depth", "maxNodes", "maxEdges"]);
      const unsupported = Object.keys(value.graphAnchor).filter((key) => !graphAnchorKeys.has(key));
      if (unsupported.length) fail(`Evidence need ${id} graphAnchor has unsupported fields: ${unsupported.sort().join(", ")}.`, "INVALID_EVIDENCE_NEEDS");
      const projectId = String(value.graphAnchor.projectId || "").trim();
      const worldModelId = String(value.graphAnchor.worldModelId || "").trim();
      const graphSnapshotId = String(value.graphAnchor.graphSnapshotId || "").trim();
      const rawNodeIds = value.graphAnchor.nodeIds;
      const nodeIds = Array.isArray(rawNodeIds) ? rawNodeIds.map((nodeId) => typeof nodeId === "string" ? nodeId.trim() : nodeId) : rawNodeIds;
      const depth = Number(value.graphAnchor.depth);
      const maxNodes = Number(value.graphAnchor.maxNodes);
      const maxEdges = Number(value.graphAnchor.maxEdges);
      if (!projectId || projectId.length > 256
        || !/^world-model-[a-f0-9]{24}$/.test(worldModelId)
        || !/^graph-snapshot-[a-f0-9]{24}$/.test(graphSnapshotId)
        || !Array.isArray(nodeIds) || nodeIds.length < 1 || nodeIds.length > 32
        || nodeIds.some((nodeId) => typeof nodeId !== "string" || !nodeId.trim() || nodeId.length > 256)
        || new Set(nodeIds).size !== nodeIds.length
        || !Number.isInteger(depth) || depth < 1 || depth > 3
        || !Number.isInteger(maxNodes) || maxNodes < nodeIds.length || maxNodes > 500
        || !Number.isInteger(maxEdges) || maxEdges < 1 || maxEdges > 1000
        || relationTypes.length < 1 || facets.length > 0) {
        fail(`Evidence need ${id} graphAnchor must be exact, current-bindable, relation-bounded, and within traversal limits.`, "INVALID_EVIDENCE_NEEDS");
      }
      const proposal = { projectId, worldModelId, graphSnapshotId, nodeIds: [...nodeIds].sort(), depth, maxNodes, maxEdges };
      graphAnchor = { ...proposal, proposalDigest: digest(canonicalJson(proposal)) };
    }
    const minimumItems = value.minimumItems == null ? 1 : Number(value.minimumItems);
    if (!Number.isInteger(minimumItems) || minimumItems < 1 || minimumItems > 20) fail(`Evidence need ${id} minimumItems must be an integer from 1 to 20.`, "INVALID_EVIDENCE_NEEDS");
    const rationale = value.rationale == null ? "" : String(value.rationale).trim();
    if (rationale.length > 500) fail(`Evidence need ${id} rationale must be at most 500 characters.`, "INVALID_EVIDENCE_NEEDS");
    return { id, kind, paths, entityKeys, observationIds, facets, relationTypes, graphAnchor, minimumItems, rationale };
  });
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function evidenceNeedContract(task, evidenceNeeds, format = formatForVerifiedOwner()) {
  const needs = normalizeEvidenceNeeds(evidenceNeeds);
  const contract = {
    owner: format.value("HEAD"),
    scope: "task-local-context-compilation",
    needs,
    productCanonAuthority: false,
    instructionAuthority: false,
    reviewAuthority: false,
    recoveryAuthority: false,
  };
  return contract;
}

function facetMatch(value, facets) {
  if (!facets.length) return true;
  const available = terms(value);
  return facets.every((facet) => available.has(facet));
}

// Only allowlisted evidence values enter lexical coverage. JSON property names,
// generated identities and query/selection/diagnostic provenance remain in the
// original record and its digest, but cannot satisfy their own request.
function facetContentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(facetContentText).join(" ");
  return "";
}

function relationFacetValues(relation) {
  const endpoint = (value) => value && typeof value === "object"
    ? [value.kind, value.path, value.name, value.specifier, value.symbolKind] : [];
  return [relation.type, relation.endpointPaths, endpoint(relation.from), endpoint(relation.to),
    relation.evidence?.path, relation.specifier, relation.callee];
}

function productEntityFacetValues(entity) {
  const semantic = entity.semantic || {};
  return [entity.kind?.replace(/Revision$/, ""), entity.key, entity.path, entity.name, entity.relationshipType, entity.subject,
    semantic.key, semantic.name, semantic.description, semantic.statement, semantic.status,
    semantic.parentFeatureGroupKeys, semantic.featureGroupKeys, semantic.capabilityKeys,
    (semantic.governedBy || []).map((reference) => [reference.kind, reference.key])];
}

function candidateFacetContent(candidate) {
  const record = candidate.record;
  const evidenceSummaries = Array.isArray(record.evidence) ? record.evidence.map((item) => item.summary) : [];
  switch (candidate.kind) {
    case "Claim":
    case "Unknown":
      return facetContentText([record.statement, record.tags, evidenceSummaries]);
    case "Decision":
      return facetContentText([record.title, record.decision, record.reason, record.constraints, record.tags, evidenceSummaries]);
    case "RepositoryFile":
      return facetContentText([record.path, record.classification, record.language,
        (record.symbols || []).map((item) => [item.kind, item.name]),
        (record.dependencies || []).map((item) => [item.kind, item.specifier]),
        (record.semanticRelationships || []).map(relationFacetValues),
        (record.temporalRelationships || []).map(relationFacetValues)]);
    case "ProductContext":
      return facetContentText([(record.entities || []).map(productEntityFacetValues), (record.relationships || []).map(relationFacetValues)]);
    case "GitDecisionEvidence":
      return facetContentText([record.subject, record.body, record.author?.name, record.author?.email, record.refs]);
    case "RuntimeStateEvidence":
      return facetContentText([record.runtime, record.kind, record.state, record.providerVersion, record.capabilities]);
    default:
      return "";
  }
}

function evidenceItem(candidate, { id = candidate.id, kind, path = null, relationType = null, value = candidate.record } = {}) {
  return {
    id,
    carrierCandidateId: candidate.id,
    kind,
    path,
    relationType,
    ...(kind?.startsWith("repository-") ? { representation: candidate.record.representation } : {}),
  };
}

function candidateEvidenceMatches(candidate, need) {
  const record = candidate.record;
  const candidateBody = candidateFacetContent(candidate);
  if (need.kind === "observation") {
    return candidate.kind === "ObservationEvidence" && need.observationIds.includes(candidate.id)
      ? [evidenceItem(candidate, { kind: need.kind })]
      : [];
  }
  if (need.paths.length && !["semantic-relation", "temporal-relation"].includes(need.kind) && (!record.path || !need.paths.includes(record.path))) return [];
  if (candidate.kind === "GraphTraversalEvidence" && record.evidenceNeedId !== need.id) return [];
  let matchedEntityKeys = [];
  if (need.entityKeys.length) {
    if (candidate.kind !== "ProductContext") return [];
    const presentKeys = new Set((record.entities || []).flatMap((item) => [item.key, item.semantic?.key]).filter(Boolean));
    matchedEntityKeys = need.entityKeys.filter((key) => presentKeys.has(key));
    if (!matchedEntityKeys.length) return [];
  }
  if (!["semantic-relation", "temporal-relation", "product-context"].includes(need.kind) && !facetMatch(candidateBody, need.facets)) return [];
  const simpleKinds = {
    claim: "Claim",
    decision: "Decision",
    "git-decision": "GitDecisionEvidence",
    "product-context": "ProductContext",
    "runtime-state": "RuntimeStateEvidence",
    unknown: "Unknown",
  };
  if (simpleKinds[need.kind]) {
    if (need.kind === "product-context") {
      if (candidate.kind !== "ProductContext") return [];
      const identities = record.entities.filter((entity) => (!need.entityKeys.length || matchedEntityKeys.includes(entity.key))
        && facetMatch(facetContentText(productEntityFacetValues(entity)), need.facets)
        && entity.logicalEntityId && entity.currentRevisionId
        && entity.authorityClass === "canon-projected" && entity.freshness === "current")
        .map((entity) => ({
          projectId: record.projectId,
          productModelId: record.productModelId,
          productModelHash: record.productModelHash,
          logicalEntityId: entity.logicalEntityId,
          revisionId: entity.currentRevisionId,
          entityKey: entity.key,
        }));
      return [...new Map(identities.map((identity) => [canonicalJson(identity), identity])).values()].map((identity) => ({
        ...evidenceItem(candidate, {
          id: `product-entity:${digest(canonicalJson(identity))}`,
          kind: need.kind,
          value: identity,
        }),
        productEntity: identity,
      }));
    }
    return candidate.kind === simpleKinds[need.kind]
      ? [evidenceItem(candidate, { kind: need.kind, path: record.path || null })]
      : [];
  }
  if (need.kind.startsWith("repository-")) {
    if (candidate.kind !== "RepositoryFile") return [];
    if (need.kind === "repository-source" && record.classification !== "source") return [];
    if (need.kind === "repository-test" && record.classification !== "test") return [];
    return [evidenceItem(candidate, { kind: need.kind, path: record.path })];
  }
  const relationValues = need.kind === "semantic-relation"
    ? (candidate.kind === "RepositoryFile" ? record.semanticRelationships || [] : [])
    : candidate.kind === "RepositoryFile"
      ? record.temporalRelationships || []
      : ["ProductContext", "GraphTraversalEvidence"].includes(candidate.kind) ? record.relationships || [] : [];
  return relationValues.filter((relation) => relationMatchesNeed(relation, need, record.path || "")).map((relation, index) => {
    const relationType = String(relation.type || "").toUpperCase();
    const relationId = relation.id || relation.edgeId || `${candidate.id}:${relationType}:${index}`;
    return evidenceItem(candidate, {
      id: relationId,
      kind: need.kind,
      path: record.path || null,
      relationType,
      value: relation,
    });
  });
}

// HEAD owns evidence requirements and sufficiency. Match references guide packing
// and expose missing material; they are not an inclusion proof or execution gate.
function selectContext(candidates, needs, maximum, baseCost) {
  const matches = new Map(candidates.map(candidate => [candidate.id,
    Object.fromEntries(needs.map(need => [need.id, candidateEvidenceMatches(candidate, need)]))]));
  const ordered = [...candidates].sort((a, b) =>
    Number(Object.values(matches.get(b.id)).some(items => items.length)) -
    Number(Object.values(matches.get(a.id)).some(items => items.length)) ||
    b.score - a.score || a.id.localeCompare(b.id));
  const included = [], excluded = [];
  let used = baseCost;
  for (const candidate of ordered) {
    const reason = used + candidate.approxTokens > maximum ? "context-budget" : null;
    if (reason) excluded.push({ id: candidate.id, kind: candidate.kind, reason });
    else { included.push(candidate); used += candidate.approxTokens; }
  }
  const includedIds = new Set(included.map(candidate => candidate.id));
  const evidenceGaps = needs.flatMap(need => {
    const collect = items => new Set(items.flatMap(candidate => matches.get(candidate.id)[need.id].map(item => item.id))).size;
    const available = collect(candidates), selected = collect(included);
    return selected >= need.minimumItems ? [] : [{ id: need.id, kind: need.kind,
      requestedMinimum: need.minimumItems, selected, available,
      availabilityScope: "compiled-candidate-material-only", missingEvidenceMayExist: true,
      reason: available > selected ? "context-budget" : "matching-evidence-unavailable",
      omittedCandidateIds: candidates.filter(candidate => !includedIds.has(candidate.id) && matches.get(candidate.id)[need.id].length).map(candidate => candidate.id) }];
  });
  return { included, excluded, used, evidenceGaps };
}

export async function compileContext({ root = ".", task, budget = DEFAULT_CONTEXT_BUDGET, evidenceNeeds = [], persist = false, graphProjectionAdapter = null, sourceObservations = [], includeRepositoryWorld = true } = {}) {
  if (persist && sourceObservations.length) fail("Ephemeral source observations must be retained before durable Capsule compilation.", "EPHEMERAL_SOURCE_REFERENCE");
  if (typeof task !== "string" || !task.trim()) fail("Context compilation requires a task.", "TASK_REQUIRED");
  const normalizedBudget = normalizeContextBudget(budget);
  const { maxApproxTokens } = normalizedBudget;
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready to compile context; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  const projectRoot = inspected.project.projectRoot;
  const format = formatForVerifiedOwner(inspected.storage);
  const needContract = evidenceNeedContract(task, evidenceNeeds, format);
  const codeOnlyNeeds = needContract.needs.length && needContract.needs.every(need =>
    ["repository-file", "repository-source", "repository-test", "semantic-relation"].includes(need.kind));
  const sources = (await loadSources(projectRoot, includeRepositoryWorld, codeOnlyNeeds ? ["code"] : null, inspected.storage));
  const snapshot = contextSnapshot(inspected, sources);
  const projectContext = sources.raw.projectContext.trim();
  const historyClass = historyRelevance(task);
  const base = {
    objective: task,
    currentState: projectContext,
    currentDirection: sources.direction,
    authority: inspected.project.authority,
    coverage: snapshot.coverage,
    evidenceNeedContract: needContract,
  };
  const candidates = [
    ...activeCandidates(sources.knowledge, task, historyClass),
    ...(await productContextCandidates(sources.worldModel, task, graphProjectionAdapter, needContract.needs)),
    ...(await graphTraversalCandidates(sources.worldModel, needContract.needs, graphProjectionAdapter)),
    ...repositoryCandidates(sources.worldModel, task, maxApproxTokens, needContract.needs),
    ...gitDecisionCandidates(sources.worldModel, task, historyClass),
    ...runtimeStateCandidates(sources.worldModel, task),
    ...observationCandidates(projectRoot, inspected.project.projectId, needContract.needs, sourceObservations, inspected.storage),
  ].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const selection = selectContext(candidates, needContract.needs, maxApproxTokens, approxTokens(canonicalJson(base)));
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ContextCapsule",
    task,
    snapshot,
    compiler: {
      name: format.protocol("head-agent-core-context-compiler"),
      version: CONTEXT_COMPILER_VERSION,
      strategy: "source-linked-head-guided-context-packaging",
      historyRelevance: historyClass,
      lexicalNormalization: "nfkc+url-elision+camel-snake-path+bounded-korean-particle-variants",
      lexicalRole: "fallback-ranking-only-never-candidate-eligibility-or-semantic-acceptance",
    },
    budget: {
      protocol: { name: format.protocol("head-agent-core-context-budget"), version: CONTEXT_BUDGET_PROTOCOL_VERSION },
      maxApproxTokens,
      usedApproxTokens: selection.used,
      metric: {
        name: "utf16-code-units-divided-by-4-ceil",
        version: "1.0.0",
        exact: false,
        providerFit: "must-be-validated-at-runtime-adapter-boundary",
      },
    },
    evidenceNeedContract: needContract,
    evidenceGaps: selection.evidenceGaps,
    omissions: { total: selection.excluded.length, byReason: Object.fromEntries(
      [...new Set(selection.excluded.map(item => item.reason))].map(reason => [reason, selection.excluded.filter(item => item.reason === reason).length])),
      boundedRepresentations: selection.included.flatMap(({ id, record }) => {
        const limits = record.evidenceOmissions || record.projectionOmissions;
        return limits && Object.values(limits).some(value => value === true || typeof value === "number" && value > 0)
          ? [{ candidateId: id, ...limits }] : [];
      }), countsScope: "observed-candidates-and-bounded-representations; not-total-project-coverage" },
    uncertainty: [
      "HEAD assesses semantic sufficiency; selection and lexical matching do not establish correctness or approval.",
      ...(sources.worldModel?.status !== "current" ? ["Repository World evidence is absent, unavailable or stale; inspect task-relevant current source directly."] : []),
      ...(selection.evidenceGaps.length ? ["Some HEAD-selected evidence is missing or outside this budget; dependent judgments need further inspection."] : []),
      ...(selection.included.some(item => item.kind === "RepositoryFile") ? ["Repository metadata is included; original source bodies have not been consumed."] : []),
      ...(approxTokens(canonicalJson(base)) > maxApproxTokens ? ["Required current direction exceeds the requested budget; preserved without truncation."] : []),
    ],
    semanticSufficiencyOwner: format.value("HEAD"),
    authority: inspected.project.authority,
    currentState: projectContext,
    currentDirection: sources.direction,
    claims: selection.included.filter((item) => item.kind === "Claim").map((item) => item.record),
    decisions: selection.included.filter((item) => item.kind === "Decision").map((item) => item.record),
    unknowns: selection.included.filter((item) => item.kind === "Unknown").map((item) => item.record),
    repositoryContext: selection.included.filter((item) => item.kind === "RepositoryFile").map((item) => item.record),
    repositoryWorldFreshness: sources.worldModel?.freshness || null,
    productContext: selection.included.filter((item) => item.kind === "ProductContext").map((item) => item.record),
    gitDecisionEvidence: selection.included.filter((item) => item.kind === "GitDecisionEvidence").map((item) => item.record),
    runtimeStateEvidence: selection.included.filter((item) => item.kind === "RuntimeStateEvidence").map((item) => item.record),
    graphTraversalEvidence: selection.included.filter((item) => item.kind === "GraphTraversalEvidence").map((item) => item.record),
    observationEvidence: selection.included.filter((item) => item.kind === "ObservationEvidence").map((item) => item.record),
    repositoryGraph: domainCurrent(sources.worldModel, "code") && sources.worldModel.snapshot.semanticGraph ? {
      semanticGraphId: sources.worldModel.snapshot.semanticGraph.semanticGraphId,
      accuracy: sources.worldModel.snapshot.semanticGraph.accuracy,
      authority: sources.worldModel.snapshot.semanticGraph.authority,
      summary: sources.worldModel.snapshot.semanticGraph.summary,
    } : null,
    repositoryTemporalGraph: sources.worldModel?.snapshot?.temporalProvenanceGraph ? {
      graphSnapshotId: sources.worldModel.snapshot.temporalProvenanceGraph.graphSnapshotId,
      graphSnapshotHash: sources.worldModel.snapshot.temporalProvenanceGraph.graphSnapshotHash,
      sourceSnapshotId: sources.worldModel.snapshot.temporalProvenanceGraph.sourceSnapshotId,
      parentSourceSnapshotIds: sources.worldModel.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds,
      authority: sources.worldModel.snapshot.temporalProvenanceGraph.authority,
      rebuildable: sources.worldModel.snapshot.temporalProvenanceGraph.rebuildable,
      uniqueAuthority: sources.worldModel.snapshot.temporalProvenanceGraph.uniqueAuthority,
      consumption: "domain-eligible-traversal-of-original-snapshot",
      summary: sources.worldModel.snapshot.temporalProvenanceGraph.summary,
    } : null,
    repositoryHistory: domainCurrent(sources.worldModel, "git") && sources.worldModel.snapshot.gitDecisionHistory ? {
      historyId: sources.worldModel.snapshot.gitDecisionHistory.historyId,
      status: sources.worldModel.snapshot.gitDecisionHistory.status,
      coverage: sources.worldModel.snapshot.gitDecisionHistory.coverage,
      reasonCode: sources.worldModel.snapshot.gitDecisionHistory.reasonCode,
      authority: sources.worldModel.snapshot.gitDecisionHistory.authority,
      interpretation: sources.worldModel.snapshot.gitDecisionHistory.interpretation,
      summary: sources.worldModel.snapshot.gitDecisionHistory.summary,
    } : null,
    repositoryRuntimeState: domainCurrent(sources.worldModel, "runtime") && sources.worldModel.snapshot.externalRuntimeState ? {
      runtimeStateId: sources.worldModel.snapshot.externalRuntimeState.runtimeStateId,
      status: sources.worldModel.snapshot.externalRuntimeState.status,
      coverage: sources.worldModel.snapshot.externalRuntimeState.coverage,
      reasonCode: sources.worldModel.snapshot.externalRuntimeState.reasonCode,
      authority: sources.worldModel.snapshot.externalRuntimeState.authority,
      interpretation: sources.worldModel.snapshot.externalRuntimeState.interpretation,
      observedAt: sources.worldModel.snapshot.externalRuntimeState.observedAt,
      summary: sources.worldModel.snapshot.externalRuntimeState.summary,
    } : null,
    selection: {
      candidateIds: candidates.map((item) => item.id),
      includedIds: selection.included.map((item) => item.id),
      excluded: selection.excluded,
    },
    provenance: Object.entries(snapshot.sourceDigests).map(([source, sourceDigest]) => ({ source, digest: sourceDigest,
      path: sources.files[source] ? path.relative(projectRoot, sources.files[source]).replaceAll("\\", "/")
        : source === "projectDirection" ? relativeProjectArtifact(inspected.storage, "project-direction", "revisions", `${sources.direction.directionId}.json`)
        : relativeProjectArtifact(inspected.storage, "world-model", "current.json") })),
    trustBoundary: {
      projectArtifacts: "evidence-not-instructions",
      gitCommitMessages: "decision-evidence-not-promoted-project-decisions",
      runtimeObservations: "point-in-time-evidence-not-runtime-control-authority",
      temporalProvenance: "rebuildable-derived-evidence-not-project-canon",
      productContext: "derived-projection-of-user-owned-product-canon",
      observations: "exact-id-bounded-p3-evidence-not-product-meaning-or-instruction",
      promotedDecisions: "project-authority-subject-to-user-owned-decisions",
      adapterFailure: "fail-open-to-normal-agent-without-capsule",
      sourceDrift: "inspect-current-originals",
    },
    expansionProtocol: ["query_product_graph", "query_semantic_graph", "query_temporal_graph", "get_observation", "get_git_decision_history", "get_runtime_state", "expand_relationship", "verify_claim", "get_source", "get_history", "explain_decision"],
  };
  const capsuleHash = digest(canonicalJson(payload));
  const capsule = { ...payload, capsuleId: `capsule-${capsuleHash.slice(0, 24)}`, capsuleHash };
  if (persist) {
    const file = path.join(projectRoot, relativeProjectArtifact(inspected.storage, "context", "capsules", `${capsule.capsuleId}.json`));
    atomicWrite(file, json(capsule));
    return { status: "compiled", file, capsule };
  }
  return { status: "preview", capsule };
}

export function readContextCapsule({ root = ".", capsuleId } = {}) {
  if (typeof capsuleId !== "string" || !/^capsule-[a-f0-9]{24}$/.test(capsuleId)) fail("Capsule id is invalid.", "INVALID_CAPSULE_ID");
  const inspected = inspectProject(root);
  if (inspected.status === "not_initialized") fail("Lode Agent Core is not initialized.", "NOT_INITIALIZED");
  const file = path.join(inspected.project.projectRoot, relativeProjectArtifact(inspected.storage, "context", "capsules", `${capsuleId}.json`));
  if (!fs.existsSync(file)) fail(`Context Capsule not found: ${capsuleId}`, "CAPSULE_NOT_FOUND");
  const capsule = readJson(file, "Context Capsule");
  const recordedHash = capsule.capsuleHash;
  const payload = { ...capsule };
  delete payload.capsuleId;
  delete payload.capsuleHash;
  const actualHash = digest(canonicalJson(payload));
  if (recordedHash !== actualHash || capsuleId !== `capsule-${actualHash.slice(0, 24)}`) fail("Context Capsule digest verification failed.", "CAPSULE_DIGEST_MISMATCH");
  if (capsule.snapshot?.projectId !== inspected.project.projectId) {
    fail("Context Capsule belongs to another HEAD Project.", "CONTEXT_CAPSULE_PROJECT_MISMATCH");
  }
  return { status: "verified", file, capsule };
}

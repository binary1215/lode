import crypto from "node:crypto";
import { familyFormatForOriginal, formatForVerifiedOwner } from "./project-storage-format.mjs";
import path from "node:path";
import { extractSemanticSourceFacts, SOURCE_ANALYSIS_VERSION } from "./source-analysis.mjs";
import { verifySourceRelationEvidenceSet } from "./source-relation-evidence.mjs";

export const SEMANTIC_GRAPH_VERSION = "0.4.0";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

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

function identity(prefix, value) {
  return `${prefix}-${digest(canonicalJson(value)).slice(0, 24)}`;
}

function repositoryModule(filesByPath, fromPath, specifier, language) {
  if (language === "python" && !specifier.startsWith(".")) {
    const pythonBase = specifier.replaceAll(".", "/");
    for (const candidate of [`${pythonBase}.py`, `${pythonBase}/__init__.py`]) if (filesByPath.has(candidate)) return candidate;
    return null;
  }
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  const candidates = path.posix.extname(base)
    ? [base]
    : [base, ...[".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx", ".py"].map((extension) => `${base}${extension}`),
      ...["index.js", "index.jsx", "index.mjs", "index.mts", "index.ts", "index.tsx", "__init__.py"].map((name) => `${base}/${name}`)];
  return candidates.find((candidate) => filesByPath.has(candidate)) || null;
}

function nodeId(kind, key) {
  return identity("semantic-node", { kind, key });
}

function edgeRecord(type, from, to, evidence, detail = {}) {
  const payload = { type, from, to, evidence, ...detail };
  return { id: identity("semantic-edge", payload), ...payload };
}

export function buildSemanticGraph({ files, sources, sourceRelationEvidence = null, storage = null }) {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const nodes = [];
  const edges = [];
  const nodeByFile = new Map();
  const symbolNodesByFile = new Map();
  const externalNodes = new Map();
  let unresolvedImportCount = 0;
  let unresolvedCallCount = 0;

  for (const file of files) {
    const fileNode = {
      id: nodeId("File", file.path),
      kind: "File",
      path: file.path,
      digest: file.digest,
      language: file.language,
      classification: file.classification,
      freshness: "active",
      trustBoundary: "evidence-not-instruction",
    };
    nodes.push(fileNode);
    nodeByFile.set(file.path, fileNode);
    const qualifiedCounts = new Map();
    const declarationCounts = new Map();
    for (const symbol of file.symbols) {
      const qualifiedKey = `${symbol.kind}:${symbol.qualifiedName}`;
      const declarationKey = `${qualifiedKey}:${symbol.signature}`;
      qualifiedCounts.set(qualifiedKey, (qualifiedCounts.get(qualifiedKey) || 0) + 1);
      declarationCounts.set(declarationKey, (declarationCounts.get(declarationKey) || 0) + 1);
    }
    const occurrences = new Map();
    const symbols = file.symbols.map((symbol) => {
      const qualifiedKey = `${symbol.kind}:${symbol.qualifiedName}`;
      const declarationKey = `${qualifiedKey}:${symbol.signature}`;
      const occurrence = (occurrences.get(declarationKey) || 0) + 1;
      occurrences.set(declarationKey, occurrence);
      const overloaded = qualifiedCounts.get(qualifiedKey) > 1;
      const identityAmbiguous = symbol.identityAmbiguous || declarationCounts.get(declarationKey) > 1;
      const identitySignature = overloaded ? symbol.signature : "";
      const identityOccurrence = identityAmbiguous ? occurrence : 1;
      return {
        id: nodeId("Symbol", JSON.stringify({ path: file.path, symbolKind: symbol.kind, qualifiedName: symbol.qualifiedName,
          signature: identitySignature, occurrence: identityOccurrence })),
        kind: "Symbol",
        path: file.path,
        fileDigest: file.digest,
        name: symbol.name,
        symbolKind: symbol.kind,
        line: symbol.line,
        endLine: symbol.endLine,
        scopePath: symbol.scopePath,
        qualifiedName: symbol.qualifiedName,
        signature: symbol.signature,
        identityAmbiguous,
        identitySignature,
        identityOccurrence,
        freshness: "active",
        trustBoundary: "evidence-not-instruction",
      };
    });
    symbolNodesByFile.set(file.path, symbols);
    for (const symbol of symbols) {
      nodes.push(symbol);
      edges.push(edgeRecord("DECLARES", fileNode.id, symbol.id, { path: file.path, line: symbol.line, digest: file.digest }, {
        confidence: "heuristic",
        evidenceSource: { kind: "heuristic-qualified-declaration-scan", sourceAnalysisVersion: SOURCE_ANALYSIS_VERSION },
      }));
    }
  }

  const externalNode = (specifier) => {
    if (!externalNodes.has(specifier)) {
      const node = {
        id: nodeId("ExternalDependency", specifier),
        kind: "ExternalDependency",
        specifier,
        freshness: "active",
        trustBoundary: "evidence-not-instruction",
      };
      externalNodes.set(specifier, node);
      nodes.push(node);
    }
    return externalNodes.get(specifier);
  };

  for (const file of files) {
    const source = sources?.get?.(file.path) || null;
    const semanticFacts = file.semanticFacts || (source ? extractSemanticSourceFacts(source.content, file.language) : null);
    if (!semanticFacts) continue;
    const fromNode = nodeByFile.get(file.path);
    const bindings = semanticFacts.bindings;
    const dependencyTargets = new Map();
    for (const dependency of file.dependencies) {
      if (dependency.kind !== "module") continue;
      const targetPath = repositoryModule(filesByPath, file.path, dependency.specifier, file.language);
      const targetNode = targetPath ? nodeByFile.get(targetPath) : externalNode(dependency.specifier);
      if (!targetPath && dependency.specifier.startsWith(".")) unresolvedImportCount += 1;
      dependencyTargets.set(dependency.specifier, { targetPath, targetNode });
      edges.push(edgeRecord("IMPORTS", fromNode.id, targetNode.id, { path: file.path, line: dependency.line || 1, digest: file.digest }, {
        specifier: dependency.specifier,
        resolution: targetPath ? "repository-file" : "external-or-unresolved",
        confidence: "heuristic",
      }));
    }
    const bindingByLocal = new Map(bindings.map((binding) => [binding.local, binding]));
    const localSymbols = symbolNodesByFile.get(file.path) || [];
    for (const call of semanticFacts.calls) {
      const parts = call.callee.split(".");
      const base = parts[0];
      const member = parts[1] || null;
      const callerMatches = call.callerQualifiedName
        ? localSymbols.filter((symbol) => symbol.qualifiedName === call.callerQualifiedName && ["function", "binding"].includes(symbol.symbolKind))
        : [];
      const caller = callerMatches.length === 1 && !call.callerIdentityAmbiguous ? callerMatches[0] : fromNode;
      const localTargets = !member ? localSymbols.filter((symbol) => symbol.name === base && !symbol.identityAmbiguous) : [];
      let target = localTargets.length === 1 ? localTargets[0] : null;
      const binding = bindingByLocal.get(base);
      if (!target && binding) {
        const resolved = dependencyTargets.get(binding.specifier) || {
          targetPath: repositoryModule(filesByPath, file.path, binding.specifier, file.language),
          targetNode: null,
        };
        if (resolved.targetPath) {
          const targetName = member || (binding.imported === "default" || binding.imported === "*" ? null : binding.imported);
          if (targetName) {
            const importedTargets = (symbolNodesByFile.get(resolved.targetPath) || [])
              .filter((symbol) => symbol.name === targetName && !symbol.identityAmbiguous);
            if (importedTargets.length === 1) target = importedTargets[0];
          }
        }
      }
      if (!target) { unresolvedCallCount += 1; continue; }
      edges.push(edgeRecord("CALLS", caller.id, target.id, { path: file.path, line: call.line, digest: file.digest }, {
        callee: call.callee,
        confidence: "heuristic",
        evidenceSource: {
          kind: "heuristic-syntax-scan",
          sourceAnalysisVersion: SOURCE_ANALYSIS_VERSION,
          callerQualifiedName: call.callerQualifiedName,
          callerIdentityAmbiguous: call.callerIdentityAmbiguous,
        },
      }));
    }
  }

  const currentManifest = files.map((file) => ({ path: file.path, digest: file.digest, language: file.language }));
  const verifiedRelationEvidence = sourceRelationEvidence
    ? verifySourceRelationEvidenceSet(sourceRelationEvidence, { files: currentManifest })
    : null;
  const endpointNode = (endpoint) => {
    if (endpoint.kind === "file") return nodeByFile.get(endpoint.path) || null;
    if (endpoint.kind === "external") return externalNode(endpoint.specifier);
    const matches = (symbolNodesByFile.get(endpoint.path) || []).filter((symbol) => symbol.name === endpoint.name
      && symbol.symbolKind === endpoint.symbolKind && symbol.line === endpoint.line);
    return matches.length === 1 ? matches[0] : null;
  };
  if (verifiedRelationEvidence) for (const relation of verifiedRelationEvidence.relations) {
    const from = endpointNode(relation.from);
    const to = endpointNode(relation.to);
    if (!from || !to) {
      const error = new Error(`AST source relation endpoints are absent from the current semantic graph: ${relation.relationId}`);
      error.code = "SOURCE_RELATION_EVIDENCE_ENDPOINT_MISSING";
      throw error;
    }
    edges.push(edgeRecord(relation.type, from.id, to.id, relation.evidence, {
      confidence: relation.confidence,
      evidenceSource: {
        kind: "language-ast-adapter",
        analyzer: verifiedRelationEvidence.analyzer,
        evidenceSetId: verifiedRelationEvidence.evidenceSetId,
        relationId: relation.relationId,
        authority: verifiedRelationEvidence.authority,
      },
    }));
  }

  nodes.sort((left, right) => left.id.localeCompare(right.id));
  edges.sort((left, right) => left.id.localeCompare(right.id));
  const payload = {
    kind: "RepositorySemanticGraph",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-semantic-graph"), version: SEMANTIC_GRAPH_VERSION },
    authority: "derived-evidence-only",
    accuracy: verifiedRelationEvidence ? "heuristic-fallback-plus-source-separated-ast-evidence" : "heuristic-not-ast-complete",
    sourceRelationEvidence: verifiedRelationEvidence ? {
      status: "provided",
      evidenceSetId: verifiedRelationEvidence.evidenceSetId,
      evidenceSetHash: verifiedRelationEvidence.evidenceSetHash,
      analyzer: verifiedRelationEvidence.analyzer,
      relationCount: verifiedRelationEvidence.relations.length,
      authority: verifiedRelationEvidence.authority,
    } : {
      status: "not-provided",
      fallback: "heuristic-source-analysis-retained",
      authority: "none",
    },
    nodes,
    edges,
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      fileNodeCount: nodes.filter((node) => node.kind === "File").length,
      symbolNodeCount: nodes.filter((node) => node.kind === "Symbol").length,
      externalDependencyNodeCount: nodes.filter((node) => node.kind === "ExternalDependency").length,
      importEdgeCount: edges.filter((edge) => edge.type === "IMPORTS").length,
      callEdgeCount: edges.filter((edge) => edge.type === "CALLS").length,
      astEvidenceEdgeCount: edges.filter((edge) => edge.evidenceSource?.kind === "language-ast-adapter").length,
      unresolvedImportCount,
      unresolvedCallCount,
    },
  };
  const semanticGraphHash = digest(canonicalJson(payload));
  return { ...payload, semanticGraphId: `semantic-graph-${semanticGraphHash.slice(0, 24)}`, semanticGraphHash };
}

export function verifySemanticGraph(graph) {
  if (!graph || graph.kind !== "RepositorySemanticGraph") throw Object.assign(new Error("Semantic graph is invalid."), { code: "INVALID_SEMANTIC_GRAPH" });
  const payload = { ...graph };
  delete payload.semanticGraphId;
  delete payload.semanticGraphHash;
  const actual = digest(canonicalJson(payload));
  if (graph.semanticGraphHash !== actual || graph.semanticGraphId !== `semantic-graph-${actual.slice(0, 24)}`) {
    throw Object.assign(new Error("Semantic graph digest verification failed."), { code: "SEMANTIC_GRAPH_DIGEST_MISMATCH" });
  }
  if (!familyFormatForOriginal("head-agent-core-semantic-graph", graph)) throw Object.assign(new Error("Semantic graph is invalid."), { code: "INVALID_SEMANTIC_GRAPH" });
  return graph;
}

export function querySemanticGraph(graph, { query, depth = 1, maxResults = 100 } = {}) {
  verifySemanticGraph(graph);
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  if (!normalizedQuery) throw Object.assign(new Error("Semantic graph query is required."), { code: "SEMANTIC_GRAPH_QUERY_REQUIRED" });
  const safeDepth = Number(depth);
  const safeMaximum = Number(maxResults);
  if (!Number.isInteger(safeDepth) || safeDepth < 0 || safeDepth > 3) throw Object.assign(new Error("Semantic graph depth must be from 0 to 3."), { code: "INVALID_SEMANTIC_GRAPH_DEPTH" });
  if (!Number.isInteger(safeMaximum) || safeMaximum < 1 || safeMaximum > 500) throw Object.assign(new Error("Semantic graph maxResults must be from 1 to 500."), { code: "INVALID_SEMANTIC_GRAPH_LIMIT" });
  const searchable = (node) => [node.id, node.kind, node.path, node.name, node.specifier, node.symbolKind].filter(Boolean).join(" ").toLocaleLowerCase();
  const matches = graph.nodes.filter((node) => searchable(node).includes(normalizedQuery)).slice(0, safeMaximum);
  const selected = new Set(matches.map((node) => node.id));
  let frontier = new Set(selected);
  for (let level = 0; level < safeDepth && frontier.size && selected.size < safeMaximum; level += 1) {
    const next = new Set();
    for (const edge of graph.edges) if (frontier.has(edge.from) || frontier.has(edge.to)) {
      for (const id of [edge.from, edge.to]) if (!selected.has(id) && selected.size + next.size < safeMaximum) next.add(id);
    }
    for (const id of next) selected.add(id);
    frontier = next;
  }
  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  const edges = graph.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to));
  return {
    semanticGraphId: graph.semanticGraphId,
    query: normalizedQuery,
    depth: safeDepth,
    matchIds: matches.map((node) => node.id),
    nodes,
    edges,
    truncated: nodes.length >= safeMaximum,
    trustBoundary: "evidence-not-instruction",
  };
}

import path from "node:path";
import { safeGraphFile, projectGraphDigest } from "./discovery-index.mjs";

const markdown = relative => /\.(?:md|markdown)$/i.test(relative);
const sourceKey = (projectId, relative, digest) => JSON.stringify([projectId, relative, digest]);
function localTarget(root, document, href) {
  let decoded;
  try { decoded = decodeURIComponent(href); } catch { return { status: "rejected", reasonCode: "DOCUMENT_LINK_ENCODING" }; }
  if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded) || /^(?:[a-z][a-z0-9+.-]*:|[\/\\])/i.test(decoded)) {
    return { status: "rejected", reasonCode: "DOCUMENT_LINK_NOT_LOCAL_RELATIVE" };
  }
  const [location, fragment = ""] = decoded.split("#", 2);
  if (/[?:]/.test(location)) return { status: "rejected", reasonCode: "DOCUMENT_LINK_QUERY_OR_STREAM_UNSUPPORTED" };
  const relative = location ? path.posix.normalize(path.posix.join(path.posix.dirname(document), location.replaceAll("\\", "/"))) : document;
  if (relative === ".." || relative.startsWith("../") || /^(?:\.head|\.lode|\.git)(?:\/|$)/i.test(relative)
    || relative.split("/").some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    return { status: "rejected", reasonCode: "DOCUMENT_LINK_SOURCE_ESCAPE" };
  }
  try { safeGraphFile(root, relative); }
  catch (error) { return { status: "rejected", reasonCode: error.code || "DOCUMENT_LINK_SOURCE_ESCAPE" }; }
  return { path: relative, fragment, status: "pending", versionScope: "current-file-at-explicit-path-not-historical-target-proof" };
}

function linksIn(text, root, document, maximum) {
  const links = []; let fence = null, omitted = 0;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], syntax = index === 0 ? line.replace(/^\uFEFF/, "") : line;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(syntax);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^[ \t]*$/.test(syntax.slice(marker[0].length))) fence = null;
      continue;
    }
    if (fence || /^ {4}|^\t/.test(syntax)) continue;
    const visible = line.replace(/`+[^`]*`+/g, value => " ".repeat(value.length));
    for (const match of visible.matchAll(/(?<!!)\[([^\]\r\n]{1,256})\]\((<[^>\r\n]{1,2048}>|[^)\r\n]{1,2048})\)/g)) {
      if (links.length >= maximum) { omitted++; continue; }
      const destination = match[2].trim(), href = destination.startsWith("<") ? destination.slice(1, destination.indexOf(">")) : destination.split(/\s+["']/)[0].trim();
      links.push({ label: match[1], href, line: index + 1, column: match.index + 1, ...localTarget(root, document, href) });
    }
  }
  return { links, omitted };
}

// Explicit bounded source navigation only. All reads use the existing exact
// reader; no graph edges, canonical records, causal claims or network fetches.
export async function readContextDocumentLinks({ root, projectId, sources, documents,
  maxFiles = 32, maxLinks = 64, maxDepth = 2, maxBytes = 256 * 1024, excerptCharacters = 512 }) {
  const queue = documents.filter(document => markdown(document.path)).map(document => ({ ...document, depth: 0, rootKeys: [sourceKey(projectId, document.path, document.digest)] }));
  const roots = new Map(queue.map(item => [item.rootKeys[0], item])), resolvedRoots = new Map(), visited = new Map(), rendered = [], pending = [];
  let usedBytes = 0, readCount = 0, linkCount = 0, omittedLinks = 0;
  while (queue.length) {
    const request = queue.shift();
    if (readCount >= maxFiles || usedBytes >= maxBytes) {
      if (request.target) Object.assign(request.target, { status: "unavailable", reasonCode: "DOCUMENT_NAVIGATION_READ_BOUND" });
      pending.push({ path: request.path, expectedDigest: request.digest || null, depth: request.depth }); continue;
    }
    readCount++;
    const version = await sources.read(request.path, request.digest || null, { maxBytes: maxBytes - usedBytes });
    if (version.text === undefined) {
      const unavailable = { path: request.path, expectedDigest: request.digest || null, status: "unavailable", reasonCode: version.reasonCode,
        rootKeys: request.rootKeys, citedBy: request.citedBy || [] };
      if (request.target) Object.assign(request.target, unavailable); else rendered.push(unavailable);
      continue;
    }
    const identity = sourceKey(projectId, request.path, version.digest), already = visited.get(identity);
    if (request.depth === 0) resolvedRoots.set(request.rootKeys[0], projectGraphDigest(identity));
    usedBytes += Buffer.byteLength(version.text);
    if (request.target) Object.assign(request.target, { status: "available", digest: version.digest, basis: version.basis,
      excerpt: version.text.slice(0, excerptCharacters), omittedCharacters: Math.max(0, version.text.length - excerptCharacters),
      navigation: already ? "already-inspected-exact-version" : "inspected", documentId: markdown(request.path) ? projectGraphDigest(identity) : null });
    if (already) continue;
    const result = { documentId: projectGraphDigest(identity), path: request.path, digest: version.digest, basis: version.basis,
      depth: request.depth, rootKeys: [...request.rootKeys], citedBy: request.citedBy || [],
      status: "available", links: [], omittedLinks: 0 };
    visited.set(identity, result);
    if (!markdown(request.path)) continue;
    rendered.push(result);
    const parsed = linksIn(version.text, root, request.path, Math.max(0, maxLinks - linkCount));
    result.links = parsed.links; result.omittedLinks = parsed.omitted; omittedLinks += parsed.omitted; linkCount += parsed.links.length;
    for (const link of parsed.links) if (link.status === "pending") {
      link.source = { path: request.path, digest: version.digest, line: link.line, column: link.column };
      if (request.depth >= maxDepth) { link.status = "not-inspected"; link.reasonCode = "DOCUMENT_NAVIGATION_DEPTH_BOUND"; continue; }
      queue.push({ path: link.path, digest: null, depth: request.depth + 1, target: link, rootKeys: result.rootKeys });
    }
  }
  // A shared document may have been expanded before a later root reaches it.
  // Derive each root's bounded reachability over already read exact versions;
  // never inherit a first visitor's depth or fetch additional source here.
  const byId = new Map(rendered.filter(document => document.documentId).map(document => [document.documentId, document]));
  for (const document of byId.values()) document.rootKeys = [];
  let rootDepthLimited = false;
  for (const [key, first] of resolvedRoots) {
    const depths = new Map([[first, 0]]), frontier = [first];
    for (let cursor = 0; cursor < frontier.length; cursor++) {
      const current = frontier[cursor], document = byId.get(current), depth = depths.get(current);
      if (!document) continue;
      document.rootKeys.push(key);
      if (depth >= maxDepth) continue;
      for (const link of document.links) if (link.status === "available" && byId.has(link.documentId) && !depths.has(link.documentId)) {
        depths.set(link.documentId, depth + 1); frontier.push(link.documentId);
      }
    }
    for (const [id, depth] of depths) if (depth === maxDepth && byId.get(id)?.links.some(link =>
      link.status === "available" && byId.has(link.documentId) && !depths.has(link.documentId))) rootDepthLimited = true;
  }
  return { documents: rendered, roots: [...roots.values()].map(item => ({ path: item.path, digest: item.digest, key: item.rootKeys[0], citedBy: item.citedBy || [] })),
    coverage: { inspectedFiles: readCount, inspectedBytes: usedBytes, includedLinks: linkCount, omittedLinks,
      pendingFiles: pending.slice(0, maxFiles), pendingFileCount: pending.length, depthLimited: rootDepthLimited || rendered.some(document => document.links?.some(link => link.reasonCode === "DOCUMENT_NAVIGATION_DEPTH_BOUND")),
      parser: "Explicit inline Markdown links only; fenced/indented/inline code and images excluded. Other forms are not inferred.",
      limits: { maxFiles, maxLinks, maxDepth, maxBytes, excerptCharacters }, absenceEstablished: false },
    authority: { plane: "P4-derived-navigation", persisted: false, recoveryAuthority: false, promotionAuthority: false, executionAuthority: false,
      interpretation: "A local document link is navigation, not historical target version, implementation, causality or approval proof." } };
}

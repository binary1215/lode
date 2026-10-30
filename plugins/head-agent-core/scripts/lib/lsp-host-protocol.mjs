import crypto from "node:crypto";

export const LSP_HOST_PROTOCOL_VERSION = "0.1.0";
export const LSP_HOST_NORMALIZER_VERSION = "0.1.0";
export const LSP_HOST_REAL_NORMALIZER_VERSION = "0.2.0";
export const LSP_HOST_REAL_PROFILE_KIND = "head-lsp-real-rq-profile-v1";

export const LSP_HOST_LIMITS = Object.freeze({
  maxDocuments: 4,
  maxDocumentBytes: 256 * 1024,
  maxInputBytes: 1024 * 1024,
  maxConfigurationItems: 16,
  maxFrameBytes: 512 * 1024,
  maxJsonDepth: 64,
  maxFrames: 512,
  maxNotifications: 128,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  requestTimeoutMs: 5_000,
  workBudgetMs: 13_000,
  gracefulCleanupMs: 2_000,
  forceCleanupMs: 5_000,
  totalTimeoutMs: 20_000,
});

export const LSP_HOST_REAL_LIMITS = Object.freeze({
  ...LSP_HOST_LIMITS,
  maxStderrBytes: 2 * 1024 * 1024,
  maxRawEvidenceWireBytes: 1024 * 1024,
  requestTimeoutMs: 10_000,
  workBudgetMs: 30_000,
  gracefulCleanupMs: 3_000,
  forceCleanupMs: 5_000,
  totalTimeoutMs: 40_000,
});

export const LSP_HOST_REAL_GATE = Object.freeze({
  realSupport: false,
  relationQuality: "unknown",
  realGate: Object.freeze({
    id: "A03",
    status: "not-run",
    reason: "no-reviewed-pinned-real-profile-and-isolation",
  }),
  e1bEligible: false,
  authority: "ephemeral-host-evidence-only",
});

export const LSP_HOST_STATUSES = Object.freeze([
  "not-configured", "unsupported", "completed", "failed", "contaminated",
]);
export const LSP_HOST_STAGES = Object.freeze([
  "discovery", "launch", "initialize", "open", "prepare", "hierarchy", "closing", "closed",
]);
export const LSP_HOST_REASONS = Object.freeze([
  "no-profile", "unsupported-profile", "no-prepared-item", "empty", "candidates",
  "invalid-input", "launch-failed", "request-timeout", "cancelled", "frame-oversize",
  "stdout-limit", "stderr-limit", "frame-limit", "notification-limit", "invalid-framing",
  "invalid-json", "invalid-message", "unsupported-server-request", "unsupported-server-notification",
  "unknown-response-id", "duplicate-response-id", "late-response", "ambiguous-prepared-item",
  "invalid-prepare-result", "invalid-hierarchy-result", "process-crash", "cleanup-failed",
  "limit-exceeded", "mapping-mismatch", "project-mismatch", "generation-mismatch",
  "manifest-mismatch", "producer-mismatch", "uri-outside-snapshot", "invalid-range",
  "source-drift", "config-drift", "profile-drift",
]);

const statusSet = new Set(LSP_HOST_STATUSES);
const stageSet = new Set(LSP_HOST_STAGES);
const reasonSet = new Set(LSP_HOST_REASONS);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export const canonicalJson = (value) => JSON.stringify(canonicalValue(value));

export function jsonDepth(value) {
  const stack = [{ value, depth: 1 }];
  let observed = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    observed = Math.max(observed, current.depth);
    if (current.value && typeof current.value === "object") {
      for (const child of Array.isArray(current.value) ? current.value : Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return observed;
}

export function protocolError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function encodeLspMessage(message, limits = LSP_HOST_LIMITS) {
  if (!message || typeof message !== "object" || Array.isArray(message) || jsonDepth(message) > limits.maxJsonDepth) {
    throw protocolError("invalid-message", "LSP message is invalid or exceeds the JSON depth bound.");
  }
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > limits.maxFrameBytes) throw protocolError("frame-oversize", "LSP frame exceeds the byte bound.");
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"), payload]);
}

export class LspFrameParser {
  constructor(limits = LSP_HOST_LIMITS) {
    this.limits = limits;
    this.buffer = Buffer.alloc(0);
    this.expected = null;
    this.frames = 0;
    this.totalBytes = 0;
    this.closed = false;
  }

  feed(chunk) {
    if (this.closed) throw protocolError("late-response", "Bytes arrived after framing was closed.");
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.limits.maxStdoutBytes) throw protocolError("stdout-limit", "LSP stdout exceeded its cumulative bound.");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (true) {
      if (this.expected === null) {
        const boundary = this.buffer.indexOf("\r\n\r\n", 0, "ascii");
        if (boundary < 0) {
          if (this.buffer.length > 8 * 1024) throw protocolError("invalid-framing", "LSP header exceeded its bound.");
          break;
        }
        const headerText = this.buffer.subarray(0, boundary).toString("ascii");
        const lines = headerText.split("\r\n");
        const lengths = lines.filter((line) => /^content-length\s*:/i.test(line));
        if (lengths.length !== 1 || lines.some((line) => !/^[A-Za-z0-9-]+:\s*[^\r\n]*$/.test(line))) {
          throw protocolError("invalid-framing", "LSP header is malformed or ambiguous.");
        }
        const match = /^content-length\s*:\s*([0-9]+)$/i.exec(lengths[0]);
        if (!match) throw protocolError("invalid-framing", "LSP Content-Length is invalid.");
        this.expected = Number(match[1]);
        if (!Number.isSafeInteger(this.expected) || this.expected < 0) throw protocolError("invalid-framing", "LSP Content-Length is outside its numeric bound.");
        if (this.expected > this.limits.maxFrameBytes) throw protocolError("frame-oversize", "LSP frame exceeds its byte bound.");
        this.buffer = this.buffer.subarray(boundary + 4);
      }
      if (this.buffer.length < this.expected) break;
      const bytes = this.buffer.subarray(0, this.expected);
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = null;
      let message;
      try { message = JSON.parse(fatalUtf8.decode(bytes)); }
      catch { throw protocolError("invalid-json", "LSP payload is not valid UTF-8 JSON."); }
      if (!message || typeof message !== "object" || Array.isArray(message) || jsonDepth(message) > this.limits.maxJsonDepth) {
        throw protocolError("invalid-message", "LSP payload is not a bounded JSON object.");
      }
      this.frames += 1;
      if (this.frames > this.limits.maxFrames) throw protocolError("frame-limit", "LSP frame count exceeded its bound.");
      messages.push(message);
    }
    return messages;
  }

  end() {
    this.closed = true;
    if (this.expected !== null || this.buffer.length !== 0) throw protocolError("invalid-framing", "LSP stream ended with an incomplete frame.");
  }
}

function requireText(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum || value.includes("\0")) {
    throw protocolError("invalid-input", `${label} is invalid.`);
  }
  return value;
}

export function normalizeRelativePath(value) {
  const text = requireText(value, "relative path", 1024).replaceAll("\\", "/");
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text) || text.split("/").some((part) => !part || part === "." || part === "..")) {
    throw protocolError("invalid-input", "Snapshot path must be a normalized relative path.");
  }
  return text;
}

export function createSnapshotDescriptor({ projectId, generationDigest, sources, tsconfigText = null, profileIdentity = null } = {}) {
  requireText(projectId, "projectId", 256);
  if (!/^[a-f0-9]{64}$/.test(generationDigest || "")) throw protocolError("invalid-input", "generationDigest must be SHA-256.");
  if (profileIdentity !== null) throw protocolError("invalid-input", "Snapshot profile identity is unsupported.");
  if (!Array.isArray(sources) || sources.length !== 3) {
    throw protocolError("invalid-input", "Exactly 3 source documents are required for the selected profile kind.");
  }
  const fixedTsconfig = tsconfigText ?? canonicalJson({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, target: "ES2022" }, files: sources.map((item) => normalizeRelativePath(item.path)) });
  const documents = [
    ...sources.map((item) => ({ path: normalizeRelativePath(item.path), languageId: "typescript", text: requireText(item.text, "source text", LSP_HOST_LIMITS.maxDocumentBytes) })),
    { path: "tsconfig.json", languageId: "json", text: requireText(fixedTsconfig, "tsconfig", LSP_HOST_LIMITS.maxDocumentBytes) },
  ];
  if (new Set(documents.map((item) => item.path)).size !== documents.length) throw protocolError("invalid-input", "Snapshot paths must be unique.");
  const paths = documents.map((item) => item.path).sort(compareText);
  for (let index = 0; index < paths.length; index += 1) {
    for (let other = index + 1; other < paths.length; other += 1) {
      if (paths[other].startsWith(`${paths[index]}/`)) throw protocolError("invalid-input", "Snapshot file paths cannot also be directory prefixes.");
    }
  }
  let totalBytes = 0;
  const manifestDocuments = documents.map((item) => {
    const bytes = Buffer.byteLength(item.text, "utf8");
    if (bytes > LSP_HOST_LIMITS.maxDocumentBytes) throw protocolError("limit-exceeded", "A snapshot document exceeds its byte bound.");
    totalBytes += bytes;
    return { path: item.path, languageId: item.languageId, bytes, digest: sha256(Buffer.from(item.text, "utf8")) };
  });
  if (totalBytes > LSP_HOST_LIMITS.maxInputBytes) throw protocolError("limit-exceeded", "Snapshot input exceeds its aggregate byte bound.");
  const manifestPayload = {
    schemaVersion: 1,
    projectId,
    generationDigest,
    documents: manifestDocuments,
  };
  const snapshotManifestDigest = sha256(canonicalJson(manifestPayload));
  return Object.freeze({ ...manifestPayload, snapshotManifestDigest, documents: documents.map((item, index) => Object.freeze({ ...item, ...manifestDocuments[index] })) });
}

export function snapshotUri(collectionId, relativePath) {
  return `head-lsp://${encodeURIComponent(collectionId)}/${normalizeRelativePath(relativePath).split("/").map(encodeURIComponent).join("/")}`;
}

export function relativePathFromUri(uri, collectionId, allowedPaths) {
  if (typeof uri !== "string") throw protocolError("uri-outside-snapshot", "LSP URI is missing.");
  let parsed;
  try { parsed = new URL(uri); } catch { throw protocolError("uri-outside-snapshot", "LSP URI is invalid."); }
  if (parsed.protocol !== "head-lsp:" || parsed.hostname !== encodeURIComponent(collectionId).toLowerCase()
    || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw protocolError("uri-outside-snapshot", "LSP URI escaped the owned snapshot.");
  }
  let relative;
  try { relative = parsed.pathname.slice(1).split("/").map(decodeURIComponent).join("/"); }
  catch { throw protocolError("uri-outside-snapshot", "LSP URI encoding is invalid."); }
  relative = normalizeRelativePath(relative);
  if (!allowedPaths.has(relative)) throw protocolError("uri-outside-snapshot", "LSP URI does not name an admitted snapshot document.");
  if (uri !== snapshotUri(collectionId, relative)) throw protocolError("uri-outside-snapshot", "LSP URI is a non-canonical alias of an admitted endpoint.");
  return relative;
}

function isWindowsReservedSegment(segment) {
  const stem = segment.split(".", 1)[0].toUpperCase();
  return new Set(["CON", "PRN", "AUX", "NUL"]).has(stem) || /^(COM|LPT)[1-9]$/.test(stem);
}

export function serializePinnedTlsWindowsFixtureUri(nativeRealPath) {
  if (typeof nativeRealPath !== "string" || nativeRealPath.includes("/") || nativeRealPath.includes("\0")
    || !/^[A-Z]:\\[A-Za-z0-9._-]+(?:\\[A-Za-z0-9._-]+)*$/.test(nativeRealPath)) {
    throw protocolError("unsupported-profile", "Real LSP fixture path is outside the pinned Windows path grammar.");
  }
  const segments = nativeRealPath.slice(3).split("\\");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.endsWith(".") || segment.endsWith(" ")
    || segment.includes(":") || isWindowsReservedSegment(segment))) {
    throw protocolError("unsupported-profile", "Real LSP fixture path contains an unsupported Windows segment.");
  }
  return `file:///${nativeRealPath[0].toLowerCase()}%3A/${segments.join("/")}`;
}

export function admittedRealDocumentFromUri(uri, documents) {
  if (typeof uri !== "string" || Buffer.byteLength(uri, "utf8") > 4096 || !Array.isArray(documents)) {
    throw protocolError("uri-outside-snapshot", "Real LSP URI is not a bounded admitted endpoint.");
  }
  const matches = documents.filter((document) => document?.languageId === "typescript"
    && Array.isArray(document.allowedUris) && document.allowedUris.length === 2 && document.allowedUris.includes(uri));
  if (matches.length !== 1) throw protocolError("uri-outside-snapshot", "Real LSP URI is outside the finite admission manifest.");
  return matches[0];
}

export function offsetAtPosition(text, position) {
  if (!position || !Number.isSafeInteger(position.line) || position.line < 0 || !Number.isSafeInteger(position.character) || position.character < 0) {
    throw protocolError("invalid-range", "LSP position is invalid.");
  }
  const lines = text.split("\n");
  if (position.line >= lines.length) throw protocolError("invalid-range", "LSP line is outside the document.");
  const line = lines[position.line].endsWith("\r") ? lines[position.line].slice(0, -1) : lines[position.line];
  if (position.character > line.length) throw protocolError("invalid-range", "LSP UTF-16 character is outside the line.");
  let offset = 0;
  for (let index = 0; index < position.line; index += 1) offset += lines[index].length + 1;
  return offset + position.character;
}

export function validateRange(text, range) {
  if (!range || typeof range !== "object") throw protocolError("invalid-range", "LSP range is missing.");
  const start = offsetAtPosition(text, range.start);
  const end = offsetAtPosition(text, range.end);
  if (end < start) throw protocolError("invalid-range", "LSP range is reversed.");
  return { start, end };
}

export function positionAtOffset(text, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw protocolError("invalid-range", "Text offset is invalid.");
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1).replace(/\r$/, "").length };
}

function codeMask(text) {
  const chars = text.split("");
  let mode = "code";
  let quote = null;
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];
    if (mode === "line") {
      if (current === "\n") mode = "code";
      else chars[index] = " ";
    } else if (mode === "block") {
      if (current === "*" && next === "/") { chars[index] = chars[index + 1] = " "; index += 1; mode = "code"; }
      else if (current !== "\n" && current !== "\r") chars[index] = " ";
    } else if (mode === "string") {
      if (current === "\\") { chars[index] = " "; if (index + 1 < chars.length) chars[++index] = " "; }
      else if (current === quote) { chars[index] = " "; mode = "code"; quote = null; }
      else if (current !== "\n" && current !== "\r") chars[index] = " ";
    } else if (current === "/" && next === "/") {
      chars[index] = chars[index + 1] = " "; index += 1; mode = "line";
    } else if (current === "/" && next === "*") {
      chars[index] = chars[index + 1] = " "; index += 1; mode = "block";
    } else if (current === "\"" || current === "'" || current === "`") {
      chars[index] = " "; mode = "string"; quote = current;
    }
  }
  return chars.join("");
}

function commentMask(text) {
  const chars = text.split("");
  let mode = "code";
  let quote = null;
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];
    if (mode === "line") {
      if (current === "\n") mode = "code";
      else chars[index] = " ";
    } else if (mode === "block") {
      if (current === "*" && next === "/") { chars[index] = chars[index + 1] = " "; index += 1; mode = "code"; }
      else if (current !== "\n" && current !== "\r") chars[index] = " ";
    } else if (mode === "string") {
      if (current === "\\") index += 1;
      else if (current === quote) { mode = "code"; quote = null; }
    } else if (current === "/" && next === "/") {
      chars[index] = chars[index + 1] = " "; index += 1; mode = "line";
    } else if (current === "/" && next === "*") {
      chars[index] = chars[index + 1] = " "; index += 1; mode = "block";
    } else if (current === "\"" || current === "'") {
      mode = "string"; quote = current;
    }
  }
  return chars.join("");
}

function hasUnsupportedFixtureLexeme(text) {
  if (text.includes("`")) return true;
  let mode = "code";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (mode === "line") {
      if (current === "\n") mode = "code";
    } else if (mode === "block") {
      if (current === "*" && next === "/") { index += 1; mode = "code"; }
    } else if (mode === "string") {
      if (current === "\\") index += 1;
      else if (current === quote) { mode = "code"; quote = null; }
    } else if (current === "/" && next === "/") {
      index += 1;
      mode = "line";
    } else if (current === "/" && next === "*") {
      index += 1;
      mode = "block";
    } else if (current === "/") {
      return true;
    } else if (current === "\"" || current === "'") {
      mode = "string";
      quote = current;
    }
  }
  return mode === "string" || mode === "block";
}

export function boundedFixtureModuleRoute(callerText, barrelText) {
  if (hasUnsupportedFixtureLexeme(callerText) || hasUnsupportedFixtureLexeme(barrelText)) return null;
  const caller = commentMask(callerText);
  const callerCode = codeMask(callerText);
  const imports = [...caller.matchAll(/^\s*import\s*\{\s*target\s*\}\s*from\s*["']\.\/(target|barrel)["']\s*;/gm)]
    .filter((match) => callerCode.slice(match.index + match[0].indexOf("import"), match.index + match[0].indexOf("import") + 6) === "import");
  if (imports.length !== 1) return null;
  const route = imports[0][1];
  if (route === "target") return "direct";
  const barrel = commentMask(barrelText);
  const barrelCode = codeMask(barrelText);
  const exports = [...barrel.matchAll(/^\s*export\s*\{\s*target\s*\}\s*from\s*["']\.\/target["']\s*;/gm)]
    .filter((match) => barrelCode.slice(match.index + match[0].indexOf("export"), match.index + match[0].indexOf("export") + 6) === "export");
  return exports.length === 1 ? "barrel" : null;
}

export function boundedFixtureFunctionIdentity(text, name) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name || "")) throw protocolError("invalid-input", "Fixture function name is invalid.");
  if (hasUnsupportedFixtureLexeme(text)) return null;
  const masked = codeMask(text);
  const declaration = new RegExp(`\\bexport\\s+function\\s+${name}\\s*\\(\\s*\\)\\s*\\{`, "g");
  const matches = [...masked.matchAll(declaration)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const selectionStart = masked.indexOf(name, match.index);
  const open = masked.indexOf("{", match.index);
  let depth = 0;
  let close = -1;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    if (masked[index] === "}" && --depth === 0) { close = index; break; }
  }
  if (selectionStart < 0 || open < 0 || close < 0) return null;
  return {
    name,
    startOffset: match.index,
    bodyStartOffset: open + 1,
    endOffset: close + 1,
    range: { start: positionAtOffset(text, match.index), end: positionAtOffset(text, close + 1) },
    selectionRange: { start: positionAtOffset(text, selectionStart), end: positionAtOffset(text, selectionStart + name.length) },
  };
}

export function boundedFixtureCallRanges(text, functionIdentity, targetName) {
  if (!functionIdentity || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(targetName || "")) return [];
  const masked = codeMask(text);
  const body = masked.slice(functionIdentity.bodyStartOffset, functionIdentity.endOffset - 1);
  const call = new RegExp(`\\b${targetName}\\s*\\(\\s*\\)\\s*;`, "g");
  const matches = [...body.matchAll(call)];
  const remainder = body.split("");
  for (const match of matches) remainder.fill(" ", match.index, match.index + match[0].length);
  if (remainder.join("").trim() !== "") return [];
  return matches.map((match) => {
    const start = functionIdentity.bodyStartOffset + match.index + match[0].indexOf(targetName);
    return { start: positionAtOffset(text, start), end: positionAtOffset(text, start + targetName.length) };
  });
}

export function createPendingTable(binding) {
  const pending = new Map();
  const completed = new Map();
  let nextId = 1;
  return Object.freeze({
    issue(method) {
      const id = nextId++;
      pending.set(id, { method, binding: canonicalJson(binding) });
      return id;
    },
    consume(message, currentBinding = binding) {
      if (!("id" in message) || ("result" in message) === ("error" in message)) throw protocolError("invalid-message", "LSP response shape is invalid.");
      if (completed.has(message.id)) throw protocolError("duplicate-response-id", "LSP response ID was already completed.", { method: completed.get(message.id).method });
      const entry = pending.get(message.id);
      if (!entry) throw protocolError("unknown-response-id", "LSP response ID is not outstanding.");
      if (entry.binding !== canonicalJson(currentBinding)) throw protocolError("mapping-mismatch", "Host response ownership mapping changed.");
      pending.delete(message.id);
      completed.set(message.id, entry);
      return entry;
    },
    outstanding() { return [...pending.keys()]; },
    has(id) { return pending.has(id); },
  });
}

export function verifyOwnershipBinding(expected, observed) {
  if (!expected || !observed || typeof expected !== "object" || typeof observed !== "object") {
    throw protocolError("mapping-mismatch", "LSP ownership binding is missing.");
  }
  const checks = [
    ["collectionId", "mapping-mismatch"],
    ["projectId", "project-mismatch"],
    ["generationDigest", "generation-mismatch"],
    ["snapshotManifestDigest", "manifest-mismatch"],
    ["producerDigest", "producer-mismatch"],
  ];
  for (const [field, code] of checks) {
    if (typeof expected[field] !== "string" || observed[field] !== expected[field]) {
      throw protocolError(code, `LSP ownership ${field} changed.`);
    }
  }
  return true;
}

export function relationSemanticDigest({ projectId, generationDigest, snapshotManifestDigest, producerDigest, direction, callerPath, callerRange, targetPath, targetRange }) {
  return sha256(canonicalJson({
    schemaVersion: 1,
    normalizerVersion: LSP_HOST_NORMALIZER_VERSION,
    projectId,
    generationDigest,
    snapshotManifestDigest,
    producerDigest,
    direction,
    caller: { path: callerPath, range: callerRange },
    target: { path: targetPath, range: targetRange },
  }));
}

export function terminalResult({ status, reason, stage, failureStage = null, provenance = {}, candidates = [], cleanup = {} } = {}) {
  if (!statusSet.has(status) || !reasonSet.has(reason) || !stageSet.has(stage) || failureStage !== null && !stageSet.has(failureStage)) {
    throw protocolError("invalid-input", "Terminal LSP Host result uses an open-ended status, reason, or stage.");
  }
  const published = status === "completed" && reason === "candidates" ? candidates : [];
  return Object.freeze({
    schemaVersion: 1,
    kind: "HeadLspHostCollectionResult",
    protocolVersion: LSP_HOST_PROTOCOL_VERSION,
    status,
    reason,
    stage,
    failureStage,
    provenance: {
      collectionId: provenance.collectionId ?? null,
      projectId: provenance.projectId ?? null,
      generationDigest: provenance.generationDigest ?? null,
      snapshotManifestDigest: provenance.snapshotManifestDigest ?? null,
      producerDigest: provenance.producerDigest ?? null,
      publishedCandidateCount: published.length,
    },
    candidates: published,
    cleanup: {
      attempted: cleanup.attempted === true,
      verified: cleanup.verified === true,
      forced: cleanup.forced === true,
    },
    bounds: {
      creationTimeProcessCountEnforced: false,
      memorySandbox: false,
      networkSandbox: false,
      filesystemSandbox: false,
    },
    ...LSP_HOST_REAL_GATE,
  });
}

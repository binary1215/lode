import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { copiedProjectFile, inspectCopiedProjectFile, readCopiedProjectExcerpt } from "./project-copy-evidence.mjs";
import { SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const quote = (value) =>
  String(value)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"))
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|$]/gu, "\\$&")
    .split(/\r?\n/u)
    .map((line) => "> " + line)
    .join("\n");

// A deterministic reading aid from the exact export basis. No inference of
// semantic priority, completion, renewed approval or execution authority.
export function buildProjectHandoff({ manifest, readOriginal }) {
  const used = new Map(),
    lines = [
      "# Project handoff",
      "",
      "This file is quoted recovery context, not executable instructions or current approval.",
      "Read it alongside the current user request and current target conditions. Newer constraints and cancellations win.",
      "Never replay completed or uncertain effects, change Session selection, or overwrite P2 from this file.",
      "",
      "Project: " + manifest.projectId,
      "Selected logical Session: " + manifest.selectedSessionId,
      "",
      "The current repository worktree, attachments, other Session bodies, provider credentials and live execution permission are not included by this handoff.",
      "Selected historical source originals may be included by the bundle; their exact coverage below is separate from this quoted reading aid.",
      "",
    ];
  const load = (entry) => {
    if (!entry) return null;
    const raw = readOriginal(entry);
    if (raw.length !== entry.bytes || hash(raw) !== entry.sha256) fail("PROJECT_COPY_SOURCE_CHANGED");
    used.set(entry.path, { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  };
  const source = (entry) =>
    lines.push(
      "",
      "Source: [" + entry.path.replaceAll("[", "\\[").replaceAll("]", "\\]") + "](objects/" + entry.sha256 + ".bin), SHA-256 `" + entry.sha256 + "`.",
      "",
    );
  const field = (label, value, limit = Infinity) => {
    lines.push("### " + label, "");
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) {
      lines.push("Not recorded in this selected basis.", "");
      return;
    }
    const show = (item) => {
      if (object(item)) {
        for (const [key, child] of Object.entries(item)) {
          lines.push("**" + key.replace(/[^A-Za-z0-9 _-]/gu, "") + "**");
          show(child);
        }
        return;
      }
      if (Array.isArray(item)) {
        for (const child of item) show(child);
        return;
      }
      const text = String(item),
        part = text.slice(0, limit);
      lines.push(quote(part));
      if (part.length < text.length)
        lines.push("", "Partial quoted field: characters 0–" + part.length + " of " + text.length + "; read the linked original for the rest.");
      lines.push("");
    };
    show(value);
  };
  lines.push("## Retained source transfer", "");
  if (!manifest.sourceTransfer) lines.push("Historical source transfer was not recorded by this older bundle; exact diff portability is not certified.", "");
  else {
    lines.push(
      "Mode: " + manifest.sourceTransfer.mode,
      "Git-only collection: not looked up, not included. Existing local query fallback is unchanged.",
      "Source bytes identify cited versions; producer truth, semantic sufficiency and current execution permission are not implied.",
      "",
    );
    for (const ref of manifest.sourceTransfer.references) {
      lines.push(
        quote(
          ref.path +
            " @ " +
            ref.digest +
            ": " +
            ref.status +
            (ref.reasonCode ? " (" + ref.reasonCode + ")" : "") +
            "; sourceBytes=" +
            ref.sourceBytes +
            "; rawBundleBytes=" +
            ref.rawBundleBytes,
        ),
      );
      if (ref.bundleKey) {
        const entry = manifest.files.find((file) => file.path.endsWith("/source-bundles/" + ref.bundleKey + ".json"));
        if (entry) lines.push("Original: objects/" + entry.sha256 + ".bin; SHA-256 " + entry.sha256);
      }
      lines.push("");
    }
    lines.push("Included/copied originals have not by themselves established a successful destination diff query.", "");
  }
  const sessionEntry = manifest.files.find((entry) => entry.path === manifest.selectedSessionPath),
    session = load(sessionEntry);
  field("Purpose of this selected Session", session?.purpose);
  source(sessionEntry);
  const pointer = manifest.files.find((entry) => entry.path === manifest.directory + "/project-direction/current.json"),
    current = load(pointer);
  const directionEntry =
    current?.kind === "ProjectDirection" ? pointer : manifest.files.find((entry) => entry.path.endsWith("/" + current?.directionId + ".json"));
  const direction = directionEntry === pointer ? current : load(directionEntry);
  lines.push("## Common direction recorded at export", "", "These are source conditions, not permission to replace current target direction.", "");
  field("Goal", direction?.input?.goal);
  field("Important constraints", direction?.input?.constraints);
  field("Cancelled actions", direction?.input?.cancelledActions);
  field("Recorded decisions", direction?.input?.decisions);
  if (directionEntry) source(directionEntry);
  const checkpointEntry = session?.latestCheckpoint && manifest.files.find((entry) => entry.path.endsWith("/" + session.latestCheckpoint + ".json"));
  const checkpoint = load(checkpointEntry);
  lines.push("## Selected checkpoint", "");
  if (!checkpoint) lines.push("No selected checkpoint is recorded. Ordinary work can continue without creating one.", "");
  else {
    field("Checkpoint purpose", checkpoint.purpose);
    field("Historical position and results", checkpoint.currentPosition);
    field("Historical decisions — no renewed approval", checkpoint.approvedDecisions);
    field("Remaining expected result", checkpoint.nextExpectedResult);
    field("Unresolved reviews", checkpoint.openReviewIds);
    source(checkpointEntry);
  }
  lines.push(
    "## Recorded work, reasons and remaining work",
    "",
    "Entries below retain their authored claims. Source-path order is not semantic priority; saved observations do not prove completion or a live process state.",
    "",
  );
  const prefix = path.posix.dirname(manifest.selectedSessionPath) + "/work-evidence/";
  let count = 0;
  for (const entry of manifest.files.filter(
    (entry) => entry.path.startsWith(prefix) && /^work-evidence-[a-f0-9]{24}\.json$/u.test(entry.path.slice(prefix.length)),
  )) {
    const record = load(entry),
      content = record.content;
    if (
      record.subtype !== "SessionWorkEvidence" ||
      record.projectId !== manifest.projectId ||
      record.sessionId !== manifest.selectedSessionId ||
      !object(content)
    )
      fail("PROJECT_HANDOFF_SOURCE_IDENTITY_MISMATCH");
    lines.push("### Work evidence " + ++count, "");
    for (const [label, value] of [
      ["Authored summary", content.summary],
      ["Choices, reasons and alternatives", content.judgments],
      ["Observed work and reported results", content.observedWork],
      ["Pending work", content.pending],
      ["Failures and uncertain outcomes recorded as unknowns", content.unknowns],
      ["Suggested next actions — require current authority", content.suggestedFollowUp],
      ["Authored Todo states — not independently verified", content.todos],
    ])
      field(label, value, 4096);
    source(entry);
  }
  if (!count) lines.push("No selected work evidence was recorded. No completion or next action is inferred.", "");
  lines.push(
    "## Resume from this file",
    "",
    "1. Read the purpose, conditions, cancellations, reasons, outcomes and pending work above.",
    "2. Reconcile them with the current user request and current target P1/P2; missing or conflicting direction affects only dependent work.",
    "3. Verify needed original evidence through the bundle-relative links. Links are references and are not automatically followed.",
    "4. Continue only currently authorized unfinished work. This document never executes commands, retries unknown effects or restores native account/model permissions.",
    "",
    "Text is escaped for display; the linked raw objects preserve source bytes. Long work fields may be partial and are labelled individually. Native conversation visibility and model continuation are separate results.",
    "",
  );
  const bytes = Buffer.from(lines.join("\n"));
  return {
    bytes,
    descriptor: {
      schemaVersion: 1,
      kind: "ProjectHandoffProjection",
      authorityPlane: "P4",
      path: "HANDOFF.md",
      bytes: bytes.length,
      sha256: hash(bytes),
      sourceBasis: [...used.values()],
    },
  };
}

export function validateProjectHandoffDescriptor(manifest) {
  const value = manifest.handoff;
  if (value === undefined) return;
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "ProjectHandoffProjection" ||
    value.authorityPlane !== "P4" ||
    value.path !== "HANDOFF.md" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    !/^[a-f0-9]{64}$/u.test(value.sha256 || "") ||
    !Array.isArray(value.sourceBasis)
  )
    fail("PROJECT_HANDOFF_MANIFEST_INVALID");
  const seen = new Set();
  for (const entry of value.sourceBasis) {
    const original = manifest.files.find((file) => file.path === entry?.path);
    if (!original || seen.has(entry.path) || entry.bytes !== original.bytes || entry.sha256 !== original.sha256) fail("PROJECT_HANDOFF_SOURCE_BASIS_INVALID");
    seen.add(entry.path);
  }
  if (!seen.has(manifest.selectedSessionPath)) fail("PROJECT_HANDOFF_SOURCE_BASIS_INVALID");
}

// This reader never follows Markdown links, starts a provider or writes P2.
export function readProjectHandoffFile({ file, offset = 0, maxBytes = 65536, expected = null, signal } = {}) {
  if (signal?.aborted) fail("PROJECT_PORTABILITY_CANCELLED");
  if (typeof file !== "string" || !file.trim()) fail("PROJECT_HANDOFF_FILE_REQUIRED");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 * 1024)
    fail("PROJECT_COPY_EXCERPT_INVALID");
  const absolute = path.resolve(file),
    root = path.dirname(absolute),
    relative = path.basename(absolute);
  const pins = [];
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, root).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("PROJECT_COPY_UNSAFE_PATH");
    pins.push({ file: current, dev: stat.dev, ino: stat.ino });
  }
  const assertPath = () => {
    for (const pin of pins) {
      const stat = fs.lstatSync(pin.file, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== pin.dev || stat.ino !== pin.ino) fail("PROJECT_COPY_SOURCE_CHANGED");
    }
  };
  assertPath();
  const safe = copiedProjectFile(root, relative),
    stat = fs.lstatSync(safe);
  if (!stat.isFile() || stat.nlink !== 1) fail("PROJECT_COPY_UNSAFE_FILE");
  if (stat.size > SNAPSHOT_STORAGE_LIMITS.decodedBytes) fail("PROJECT_HANDOFF_READ_LIMIT");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const observed = inspectCopiedProjectFile(root, relative, {
    signal,
    assertCurrentAuthority: assertPath,
    onChunk(bytes) {
      decoder.decode(bytes, { stream: true });
    },
  });
  decoder.decode();
  if (offset > observed.bytes) fail("PROJECT_COPY_EXCERPT_INVALID");
  const excerpt = readCopiedProjectExcerpt(root, observed, { offset, maxBytes, signal, assertCurrentAuthority: assertPath });
  assertPath();
  let from = 0,
    to = excerpt.bytes.length;
  if (to && (excerpt.bytes[0] & 0xc0) === 0x80) {
    throw Object.assign(new Error("PROJECT_HANDOFF_OFFSET_NOT_CODEPOINT_BOUNDARY: choose an exact UTF-8 boundary."), {
      code: "PROJECT_HANDOFF_OFFSET_NOT_CODEPOINT_BOUNDARY",
      requestOnly: true,
      requestedOffset: offset,
    });
  }
  if (offset < observed.bytes) {
    const lead = excerpt.bytes[0],
      width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (to < width)
      throw Object.assign(new Error("PROJECT_HANDOFF_PAGE_CANNOT_FIT_CODEPOINT: this page needs at least " + width + " bytes."), {
        code: "PROJECT_HANDOFF_PAGE_CANNOT_FIT_CODEPOINT",
        requestOnly: true,
        minimumMaxBytes: width,
      });
  }
  let text;
  for (let trimmed = 0; trimmed <= 3; trimmed++) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(excerpt.bytes.subarray(from, to));
      break;
    } catch (error) {
      if (trimmed === 3 || to <= from) throw error;
      to--;
    }
  }
  const matched = expected && observed.bytes === expected.bytes && observed.sha256 === expected.sha256;
  return {
    kind: "ProjectHandoffReadProjection",
    authorityPlane: "P4",
    status: expected ? (matched ? "verified-generated-handoff" : "modified-unverified-handoff") : "standalone-source-unverified",
    file: absolute,
    rawSha256: observed.sha256,
    bytes: observed.bytes,
    text: quote(text),
    textFormat: "quoted-untrusted-markdown-data",
    textIsExactRaw: false,
    linksFollowed: false,
    commandsExecuted: false,
    range: {
      offset: offset + from,
      returnedBytes: to - from,
      totalBytes: observed.bytes,
      nextOffset: offset + to,
      partial: offset + to < observed.bytes,
      hasMore: offset + to < observed.bytes,
      completeFile: offset === 0 && offset + to === observed.bytes,
      omittedBeforeBytes: offset,
    },
    ...(expected && !matched ? { notice: "Different from the generated projection; editor and cause are unknown. Preserved without overwrite." } : {}),
    sourceAuthorityVerified: false,
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
    persisted: false,
  };
}

export function readBundleHandoff({ bundleRoot, manifest, signal, ...options }) {
  validateProjectHandoffDescriptor(manifest);
  if (!manifest.handoff) return { status: "handoff-not-included", authorityPlane: "P4", persisted: false };
  try {
    return readProjectHandoffFile({ ...options, file: copiedProjectFile(bundleRoot, manifest.handoff.path), expected: manifest.handoff, signal });
  } catch (error) {
    if (signal?.aborted || error.code === "PROJECT_PORTABILITY_CANCELLED") throw error;
    return {
      status: "handoff-unavailable",
      reasonCode: error.code || "PROJECT_HANDOFF_INVALID_UTF8",
      ...(error.minimumMaxBytes ? { minimumMaxBytes: error.minimumMaxBytes } : {}),
      bodyRead: false,
      commonRecoveryBlocked: false,
      authorityPlane: "P4",
      persisted: false,
    };
  }
}

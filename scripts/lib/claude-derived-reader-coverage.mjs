import { isDeepStrictEqual } from "node:util";
import { CLAUDE_DERIVED_FORMAT } from "./claude-derived-encoder.mjs";
import { claudeMessageDigest } from "./claude-message-digest.mjs";

// Exact Desktop2.1.317 envelope observed with SDK0.3.234. The SDK's isMeta
// filtering is broader; do not adopt that broader rule as evidence completeness.
export const CLAUDE_LOCAL_COMMAND_CAVEAT = "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>";
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
function knownAppendedNotice(row, index, prefixCount) {
  return index >= prefixCount && row.type === "user" && row.message?.role === "user"
    && row.message.content === CLAUDE_LOCAL_COMMAND_CAVEAT && row.isMeta === true && row.isSidechain === false
    && row.version === CLAUDE_DERIVED_FORMAT.cliVersion && row.entrypoint === "claude-desktop" && row.userType === "external"
    && uuid(row.uuid) && uuid(row.parentUuid) && uuid(row.promptId)
    && typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp))
    && !Object.hasOwn(row, "origin") && !Object.hasOwn(row, "turnOrigin") && !Object.hasOwn(row, "promptSource");
}

export function compareClaudeDerivedReader({ nativeMessages, returned, nativeId, prefixCount, exactSessionObserved, digestObservation = false, nativeMessageDigests = null }) {
  const originals = new Map(), seen = new Set(), matched = new Set(), mismatches = [];
  for (const [index, row] of nativeMessages.entries()) {
    if (typeof row.uuid !== "string" || originals.has(row.uuid) || row.sessionId !== nativeId || row.message?.role !== row.type)
      mismatches.push({ index, uuid: row.uuid, code: "invalid-or-duplicate-native-identity" });
    else originals.set(row.uuid, { row, index });
  }
  let previousIndex = -1;
  for (const [index, row] of returned.entries()) {
    if (typeof row?.uuid !== "string" || seen.has(row.uuid)) {
      mismatches.push({ index, uuid: row?.uuid, code: "duplicate-or-invalid-reader-uuid" }); continue;
    }
    seen.add(row.uuid);
    const original = originals.get(row.uuid);
    const bodyMatches = original && (digestObservation ? /^[a-f0-9]{64}$/u.test(row.messageSha256 ?? "") && row.messageSha256 === (nativeMessageDigests?.get(row.uuid) ?? claudeMessageDigest(original.row.message))
      : isDeepStrictEqual(row.message, original.row.message));
    if (!original || row.type !== original.row.type || row.session_id !== nativeId || !bodyMatches)
      mismatches.push({ index, uuid: row.uuid, code: "role-body-id-mismatch" });
    else matched.add(row.uuid);
    if (original) {
      if (original.index <= previousIndex) mismatches.push({ index, uuid: row.uuid, code: "reader-order-mismatch" });
      previousIndex = original.index;
    }
  }
  const missing = nativeMessages.flatMap((row, index) => seen.has(row.uuid) ? [] : [{ uuid: row.uuid, role: row.type, rawIndex: index,
    contentTypes: typeof row.message?.content === "string" ? ["text-string"]
      : Array.isArray(row.message?.content) ? row.message.content.map(block => block?.type) : ["invalid"],
    classification: knownAppendedNotice(row, index, prefixCount) ? "qualified-desktop-local-command-caveat-omission" : "unexplained-reader-omission" }]);
  const declaredReaderOmissions = missing.filter(row => row.classification === "qualified-desktop-local-command-caveat-omission");
  const unexplainedMissing = missing.filter(row => row.classification !== "qualified-desktop-local-command-caveat-omission");
  const rawCoverageComplete = exactSessionObserved && missing.length === 0 && mismatches.length === 0 && returned.length === nativeMessages.length;
  return { missing, mismatches, declaredReaderOmissions, unexplainedMissing, rawCoverageComplete,
    readerProjectionCoverageComplete: exactSessionObserved && mismatches.length === 0 && unexplainedMissing.length === 0
      && returned.length + declaredReaderOmissions.length === nativeMessages.length,
    derivedPrefixCoverageComplete: exactSessionObserved && mismatches.length === 0
      && nativeMessages.slice(0, prefixCount).every(row => matched.has(row.uuid)),
    omissionProfile: "Desktop2.1.317/SDK0.3.234 exact appended local-command-caveat envelope; no authenticity or authority inferred" };
}

import { pathToFileURL } from "node:url";
import { claudeMessageDigest, CLAUDE_SDK_DIGEST_PROFILE } from "./lib/claude-message-digest.mjs";

// Fixed read-only official SDK APIs, one exact selected session. No query,
// resume, session store, model, account, list-all-projects or credential APIs.
const [entry, cwd, nativeId, maximumText, observationMode] = process.argv.slice(2);
if (observationMode !== undefined && observationMode !== CLAUDE_SDK_DIGEST_PROFILE) throw Error("DERIVED_READER_OBSERVATION_PROFILE_INVALID");
const maximum = Number(maximumText);
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(nativeId || "")
  || !Number.isSafeInteger(maximum) || maximum < 1) throw Error("DERIVED_READER_SELECTION_INVALID");
const sdk = await import(pathToFileURL(entry).href);
if (typeof sdk.getSessionMessages !== "function" || typeof sdk.getSessionInfo !== "function") throw Error("DERIVED_READER_API_UNAVAILABLE");
const messages = [], seen = new Set();
// SDK 0.3.234 reparses the complete transcript before applying offset/limit.
// Digest observations already have the exact current transcript count as a
// bound and emit no bodies: avoid reparsing that body for every 128 hashes.
// Preserve the existing raw-output pagination profile.
const pageSize = observationMode ? maximum : Math.min(128, maximum);
for (let offset = 0; ; ) {
  const page = await sdk.getSessionMessages(nativeId, { dir: cwd, limit: pageSize, offset });
  if (!Array.isArray(page)) throw Error("DERIVED_READER_PAGE_INVALID");
  for (const row of page) {
    if (typeof row?.uuid !== "string" || seen.has(row.uuid)) throw Error("DERIVED_READER_PAGINATION_REPEATED");
    seen.add(row.uuid); messages.push(observationMode ? { uuid: row.uuid, type: row.type, session_id: row.session_id,
      messageSha256: claudeMessageDigest(row.message) } : row);
    if (messages.length > maximum) throw Error("DERIVED_READER_SOURCE_BOUND_EXCEEDED");
  }
  if (page.length < pageSize) break;
  offset += page.length;
}
const sessionInfo = await sdk.getSessionInfo(nativeId, { dir: cwd });
process.stdout.write(JSON.stringify({ sdkVersion: "0.3.234", nativeId, sessionInfo: observationMode ? sessionInfo ? { sessionId: sessionInfo.sessionId } : null : sessionInfo || null, messages,
  ...(observationMode ? { observationProfile: CLAUDE_SDK_DIGEST_PROFILE, sourceBodiesReturned: false } : {}),
  pagination: { pageSize, completeAtRead: true }, modelCalled: false }) + "\n");

import { pathToFileURL } from "node:url";

// Dedicated read-only SDK child. No query/resume/fork/model APIs are imported
// or called. The parent resolves an already installed exact SDK package.
const [entry, cwd, selection] = process.argv.slice(2);
const ids = JSON.parse(selection);
if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/iu.test(id))) throw Error("NATIVE_CLAUDE_SELECTION_INVALID");
const sdk = await import(pathToFileURL(entry).href);
if (typeof sdk.listSessions !== "function" || typeof sdk.getSessionMessages !== "function") throw Error("NATIVE_CLAUDE_SDK_READER_UNAVAILABLE");
const listed = await sdk.listSessions({ dir: cwd, includeWorktrees: false });
const sessions = [];
for (const id of ids) {
  const messages = await sdk.getSessionMessages(id, { dir: cwd });
  sessions.push({ sessionId: id, listed: listed.some(row => row.sessionId === id), messages });
}
process.stdout.write(JSON.stringify({ sessions }) + "\n");

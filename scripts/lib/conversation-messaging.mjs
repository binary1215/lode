import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveProjectStorage } from "./project-storage-format.mjs";
import { claudeChannel, deliverClaudeInbox, readClaudePeerToken } from "./conversation-messaging-claude.mjs";
import { codexChannel, codexControlSocket, collectAncestors, deliverCodexTurn, windowsProcessListCommand } from "./conversation-messaging-codex.mjs";
import { deliverOpenCodePrompt, opencodeChannel, opencodePromptAvailable } from "./conversation-messaging-opencode.mjs";

const RUNTIMES = new Set(["claude", "codex", "opencode"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/u;
const MESSAGE_ID = /^msg-[a-f0-9]{24}$/u;
const TICKET_ID = /^[a-f0-9]{32}$/u;
const FRESH_MS = 10 * 60 * 1000;
const IMMEDIATE_MS = 2 * 60 * 1000;
const MAX_BODY = 6000;
const MAX_INJECT = 20;
const MAX_LIST = 256;

const fail = (code, detail) => { throw Object.assign(new Error(code + (detail ? ": " + detail : "")), { code }); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nowMs = now => typeof now === "function" ? now() : Date.now();
const stamp = now => new Date(nowMs(now)).toISOString();

export function formatAddress(identity) {
  if (!identity || !RUNTIMES.has(identity.runtime) || !ID.test(identity.nativeSessionId || "")) return null;
  if (identity.agentId != null && identity.agentId !== "" && !ID.test(identity.agentId)) return null;
  if (identity.subagent) {
    if (identity.agentId) return `${identity.runtime}:${identity.nativeSessionId}/${identity.agentId}`;
    if (identity.parentSessionId && identity.parentSessionId !== identity.nativeSessionId && ID.test(identity.parentSessionId)) return `${identity.runtime}:${identity.nativeSessionId}`;
    return null;
  }
  if (identity.agentId) return null;
  return `${identity.runtime}:${identity.nativeSessionId}`;
}

export function parseAddress(value) {
  if (typeof value !== "string") return null;
  const match = /^(claude|codex|opencode):([A-Za-z0-9][A-Za-z0-9._:-]{0,200})(?:\/([A-Za-z0-9][A-Za-z0-9._:-]{0,200}))?$/u.exec(value);
  if (!match) return null;
  return { runtime: match[1], nativeSessionId: match[2], agentId: match[3] || null, subagent: Boolean(match[3]), address: value };
}

export function identityFromCaller(caller) {
  if (!object(caller) || !RUNTIMES.has(caller.runtime) || !ID.test(caller.nativeSessionId || "")) return null;
  const agentId = ID.test(caller.agentId || "") ? caller.agentId : ID.test(caller.messagingAgentId || "") ? caller.messagingAgentId : null;
  const parentSessionId = ID.test(caller.rootSessionId || "") ? caller.rootSessionId : null;
  const subagent = caller.subagent === true || Boolean(agentId) || Boolean(parentSessionId && parentSessionId !== caller.nativeSessionId);
  const identity = { runtime: caller.runtime, nativeSessionId: caller.nativeSessionId, agentId: subagent ? agentId : null, subagent, parentSessionId: subagent ? parentSessionId : null };
  const address = formatAddress(identity);
  return address ? { ...identity, address } : null;
}

export function hookConversationIdentity(runtime, event) {
  if (!RUNTIMES.has(runtime) || !ID.test(event?.session_id || "")) return null;
  const agentId = ID.test(event?.agent_id || "") ? event.agent_id : null;
  const subagent = Boolean(agentId);
  const identity = { runtime, nativeSessionId: event.session_id, agentId: subagent ? agentId : null, subagent, parentSessionId: null };
  const address = formatAddress(identity);
  return address ? { ...identity, address } : null;
}

export function argumentDigest(args) {
  const body = { project_root: args?.project_root ?? null, to: args?.to ?? null, body: args?.body ?? null, reply_to: args?.reply_to ?? null };
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function validBody(body) {
  return typeof body === "string" && body.length > 0 && body.length <= MAX_BODY && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(body);
}

function openProject(root) {
  const storage = resolveProjectStorage(root);
  if (!storage?.directory || !storage.projectRoot) fail("CONVERSATION_PROJECT_UNAVAILABLE", "Messaging stays inside an initialized project.");
  const base = path.resolve(storage.projectRoot, storage.directory);
  const messaging = path.resolve(base, "messaging");
  const relative = path.relative(base, messaging);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("CONVERSATION_PATH_ESCAPE");
  return { root: storage.projectRoot, directory: storage.directory, messaging };
}

function slot(address) { return crypto.createHash("sha256").update(address).digest("hex"); }
function area(project, kind, address) { return path.join(project.messaging, kind, slot(address)); }
function messageFile(project, kind, address, id) {
  if (!MESSAGE_ID.test(id)) fail("CONVERSATION_MESSAGE_ID");
  return path.join(area(project, kind, address), id + ".json");
}
function presenceFile(project, address) { return path.join(project.messaging, "presence", slot(address) + ".json"); }

function readJson(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (text.length > 65536) return null;
    const parsed = JSON.parse(text);
    return object(parsed) ? parsed : null;
  } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".writing";
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

function names(directory) {
  try { return fs.readdirSync(directory).filter(name => !name.endsWith(".writing")); }
  catch { return []; }
}

function ageMs(record, now) {
  const parsed = Date.parse(record?.updatedAt || "");
  return Number.isFinite(parsed) ? Math.max(0, nowMs(now) - parsed) : Infinity;
}

function channelLive(record, environment, now, platform) {
  const channel = object(record?.channel) ? record.channel : { kind: "none" };
  const fresh = ageMs(record, now) <= FRESH_MS;
  const recent = ageMs(record, now) <= IMMEDIATE_MS;
  if (channel.kind === "claude-inbox" && typeof channel.socketPath === "string") {
    const pipe = /^\\\\[.?]\\pipe\\/u.test(channel.socketPath);
    const present = pipe || fs.existsSync(channel.socketPath);
    if (present && recent) {
      const token = readClaudePeerToken({ environment, socketPath: channel.socketPath });
      if (platform === "win32" && !token) return { reachable: fresh, delivery: fresh ? "next-prompt" : "unreachable", evidence: "claude-windows-auth-missing" };
      return { reachable: true, delivery: "immediate", evidence: pipe ? "claude-inbox-pipe" : "claude-inbox-socket" };
    }
  }
  if (channel.kind === "codex-engine" && typeof channel.engineSocket === "string" && fs.existsSync(channel.engineSocket) && recent) {
    return { reachable: true, delivery: "immediate", evidence: "codex-shared-engine" };
  }
  if (channel.kind === "opencode-prompt" && recent) return { reachable: true, delivery: "immediate", evidence: "opencode-session-prompt-registered" };
  if (fresh) return { reachable: true, delivery: "next-prompt", evidence: channel.kind || "presence" };
  return { reachable: false, delivery: "unreachable", evidence: "presence-stale" };
}

function publicConversation(record, live) {
  return {
    address: record.address, runtime: record.runtime, nativeSessionId: record.nativeSessionId,
    agentId: record.agentId ?? null, subagent: record.subagent === true, updatedAt: record.updatedAt,
    reachable: live.reachable, delivery: live.delivery, evidence: live.evidence,
  };
}

function listPresence(project) {
  return names(path.join(project.messaging, "presence")).flatMap(name => {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) return [];
    const record = readJson(path.join(project.messaging, "presence", name));
    if (!record || record.schemaVersion !== 1 || record.projectRoot !== project.root || !parseAddress(record.address)) return [];
    return [record];
  });
}

export function registerConversationPresence({ root, identity, channel, environment = process.env, now = Date.now } = {}) {
  const address = formatAddress(identity);
  if (!address) fail("CONVERSATION_SUBAGENT_IDENTITY_REQUIRED", "A subagent needs its own address and cannot register as its parent.");
  const project = openProject(root);
  const file = presenceFile(project, address);
  const existing = readJson(file);
  if (existing && existing.projectRoot === project.root && existing.subagent === false && identity.subagent === true) {
    fail("CONVERSATION_PARENT_IDENTITY", "A subagent cannot replace its parent conversation.");
  }
  const record = {
    schemaVersion: 1, address, runtime: identity.runtime, nativeSessionId: identity.nativeSessionId,
    agentId: identity.agentId ?? null, subagent: identity.subagent === true,
    parentSessionId: identity.parentSessionId ?? null, projectRoot: project.root,
    updatedAt: stamp(now), channel: channel || { kind: "none" },
  };
  writeJson(file, record);
  return record;
}

function senderOf({ caller, hostTicket, root, args, environment }) {
  const trusted = identityFromCaller(caller);
  if (caller?.subagent === true && !trusted) fail("CONVERSATION_SUBAGENT_IDENTITY_REQUIRED", "A subagent cannot send as its parent.");
  if (trusted) return trusted;
  return consumeTicket({ root, hostTicket, args, environment });
}

function consumeTicket({ root, hostTicket, args, environment }) {
  if (!TICKET_ID.test(hostTicket || "")) return null;
  const project = openProject(root);
  const file = path.join(project.messaging, "tickets", hostTicket + ".json");
  const relative = path.relative(path.join(project.messaging, "tickets"), file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const ticket = readJson(file);
  try { fs.rmSync(file, { force: true }); } catch { /* A spent ticket must not remain reusable. */ }
  if (!ticket || ticket.digest !== argumentDigest(args) || ticket.projectRoot !== project.root) return null;
  if (!Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= nowMs()) return null;
  const environmentDirectory = environment?.LODE_CONVERSATION_DIRECTORY;
  if (environmentDirectory && path.resolve(environmentDirectory) !== project.root) return null;
  return identityFromCaller(ticket.caller);
}

export function writeOpenCodeCallerTicket({ root, session, args, environment = process.env, now = Date.now } = {}) {
  if (!session || !ID.test(session.id || "") || typeof args !== "object" || args === null) return null;
  const subagent = typeof session.parentID === "string" && ID.test(session.parentID);
  const caller = { runtime: "opencode", nativeSessionId: session.id, subagent, ...(subagent ? { rootSessionId: session.parentID } : {}) };
  if (!identityFromCaller(caller)) return null;
  const project = openProject(root);
  if (path.resolve(session.directory || root) !== project.root) return null;
  const id = crypto.randomBytes(16).toString("hex");
  writeJson(path.join(project.messaging, "tickets", id + ".json"), {
    schemaVersion: 1, digest: argumentDigest(args), projectRoot: project.root, caller, expiresAt: nowMs(now) + 30_000,
  });
  return id;
}

function renderInjection(messages, remaining) {
  const blocks = messages.map(message => ["Same-project conversation message.",
    `id: ${message.id}`, `from: ${message.from.address}`, `to: ${message.to.address}`,
    message.replyTo ? `reply_to: ${message.replyTo}` : null,
    "A reply is lode_conversation_send to the from address with reply_to set to this id.",
    "body:", message.body].filter(Boolean).join("\n"));
  if (remaining > 0) blocks.push(`More same-project messages remain queued: ${remaining}.`);
  return blocks.join("\n\n");
}

function recoverInflight(project, address) {
  for (const name of names(area(project, "inflight", address))) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!MESSAGE_ID.test(id)) continue;
    const inflight = messageFile(project, "inflight", address, id);
    const message = readJson(inflight);
    if (!message) continue;
    let age = 0;
    try { age = Date.now() - fs.statSync(inflight).mtimeMs; } catch { continue; }
    // A live claimant still owns a fresh inflight file. Only a claim older than
    // the host hook timeout is returned to the inbox, or archived if already handed off.
    if (!message.handedToHost && age < 15_000) continue;
    const destination = message.handedToHost ? messageFile(project, "archive", address, id) : messageFile(project, "inbox", address, id);
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(inflight, destination);
    } catch { /* The other claimant owns this file. */ }
  }
}

function claimMessage(project, message) {
  const source = messageFile(project, "inbox", message.to.address, message.id);
  const destination = messageFile(project, "inflight", message.to.address, message.id);
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    return true;
  } catch { return false; }
}

function claimAddress(project, address) {
  recoverInflight(project, address);
  const claimed = [];
  const waiting = names(area(project, "inbox", address)).filter(name => MESSAGE_ID.test(name.slice(0, -5))).sort();
  for (const name of waiting.slice(0, MAX_INJECT)) {
    const id = name.slice(0, -5);
    const source = messageFile(project, "inbox", address, id);
    const destination = messageFile(project, "inflight", address, id);
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(source, destination);
      const message = readJson(destination);
      if (message?.id === id) claimed.push(message);
    } catch { /* Lost the rename race. */ }
  }
  return { claimed, remaining: Math.max(0, waiting.length - claimed.length) };
}

function markHanded(project, message, state, evidence, receipt = null) {
  const inflight = messageFile(project, "inflight", message.to.address, message.id);
  const next = { ...message, state, evidence, handedToHost: true, ...(receipt ? { receipt } : {}) };
  writeJson(inflight, next);
  const archive = messageFile(project, "archive", message.to.address, message.id);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.renameSync(inflight, archive);
  return next;
}

function releaseClaim(project, message) {
  const inflight = messageFile(project, "inflight", message.to.address, message.id);
  const inbox = messageFile(project, "inbox", message.to.address, message.id);
  try {
    fs.mkdirSync(path.dirname(inbox), { recursive: true });
    fs.renameSync(inflight, inbox);
  } catch { /* Already archived or released. */ }
}

function findMessage(project, id) {
  if (!MESSAGE_ID.test(id || "")) return null;
  for (const kind of ["archive", "inbox", "inflight"]) {
    const directory = path.join(project.messaging, kind);
    for (const slotName of names(directory)) {
      const file = path.join(directory, slotName, id + ".json");
      const message = readJson(file);
      if (message?.id === id && message.projectRoot === project.root) return message;
    }
  }
  return null;
}

function enqueue(project, message) {
  const file = messageFile(project, "inbox", message.to.address, message.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".writing";
  fs.writeFileSync(temporary, JSON.stringify(message));
  try { fs.renameSync(temporary, file); }
  catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* The exclusive inbox name is the claim. */ }
    throw error;
  }
  return message;
}

async function defaultDeliver({ message, presence, environment, platform }) {
  if (presence.channel?.kind === "claude-inbox") {
    const token = readClaudePeerToken({ environment, socketPath: presence.channel.socketPath });
    return deliverClaudeInbox({ socketPath: presence.channel.socketPath, platform, token, message: { ...message, text: renderInjection([message], 0) } });
  }
  if (presence.channel?.kind === "codex-engine") {
    return deliverCodexTurn({ socketPath: presence.channel.engineSocket, platform, threadId: presence.nativeSessionId, text: renderInjection([message], 0) });
  }
  return { outcome: "unavailable", evidence: presence.channel?.kind || "inbox" };
}

function resultOf(message, state, evidence) {
  return {
    kind: "ConversationMessage", id: message?.id ?? null, from: message?.from?.address ?? null, to: message?.to?.address ?? null,
    replyTo: message?.replyTo ?? null, state, evidence, persisted: state !== "unreachable", projectScoped: true,
  };
}

export async function sendProjectConversation({ root, caller = null, environment = process.env, to, body, replyTo = null, hostTicket = null, now = Date.now, platform = process.platform, deliver = null, waitMs = 0 } = {}) {
  const project = openProject(root);
  const args = { project_root: root, to, body, reply_to: replyTo };
  const from = senderOf({ caller, hostTicket, root, args, environment });
  if (!from) fail("CONVERSATION_CALLER_UNAVAILABLE", "The live host caller is required. Arguments cannot name the sender.");
  if (!validBody(body)) fail("CONVERSATION_BODY", "The message must be text of at most 6000 characters.");
  const target = parseAddress(to);
  if (!target) fail("CONVERSATION_ADDRESS", "Use runtime:id or runtime:id/agent.");
  let original = null;
  if (replyTo != null) {
    original = findMessage(project, replyTo);
    if (!original || original.to.address !== from.address) fail("CONVERSATION_REPLY_UNAVAILABLE", "A reply can come only from the conversation that received the message.");
    if (target.address !== original.from.address) fail("CONVERSATION_REPLY_TARGET", "A reply returns to the original sender.");
  }
  const presence = listPresence(project).find(record => record.address === target.address);
  if (!presence) return resultOf({ from, to: target, replyTo: replyTo ?? null }, "unreachable", "no-same-project-conversation");
  const message = {
    schemaVersion: 1, id: "msg-" + crypto.randomBytes(12).toString("hex"), projectRoot: project.root,
    from, to: { runtime: target.runtime, nativeSessionId: target.nativeSessionId, agentId: target.agentId, address: target.address },
    body, replyTo: replyTo ?? null, createdAt: stamp(now), state: "queued", evidence: "inbox", handedToHost: false,
  };
  enqueue(project, message);
  if (!claimMessage(project, message)) return resultOf(message, "queued", "inbox");
  try {
    const attempt = await (deliver || defaultDeliver)({ message, presence, environment, platform });
    if (attempt?.outcome === "delivered" || attempt?.outcome === "sent") return resultOf(markHanded(project, message, attempt.outcome, attempt.evidence, attempt.receipt ?? null), attempt.outcome, attempt.evidence);
    releaseClaim(project, message);
  } catch { releaseClaim(project, message); }
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const archived = findMessage(project, message.id);
      if (archived?.handedToHost) return resultOf(archived, archived.state, archived.evidence);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return resultOf(message, "queued", "inbox");
}

export function listProjectConversations({ root, caller = null, environment = process.env, hostTicket = null, now = Date.now, platform = process.platform } = {}) {
  const project = openProject(root);
  const args = { project_root: root, to: null, body: null, reply_to: null };
  if (caller?.subagent === true && !identityFromCaller(caller)) fail("CONVERSATION_SUBAGENT_IDENTITY_REQUIRED", "A subagent cannot list as its parent.");
  const self = identityFromCaller(caller) || consumeTicket({ root, hostTicket, args, environment });
  const rows = listPresence(project).map(record => ({ record, live: channelLive(record, environment, now, platform) }))
    .filter(item => item.live.delivery !== "unreachable" && item.record.address !== self?.address)
    .sort((a, b) => a.record.address.localeCompare(b.record.address));
  return {
    kind: "ProjectConversationList", projectScoped: true, persisted: false,
    self: self ? { address: self.address, runtime: self.runtime, subagent: self.subagent === true } : null,
    conversations: rows.slice(0, MAX_LIST).map(item => publicConversation(item.record, item.live)),
    omitted: Math.max(0, rows.length - MAX_LIST),
  };
}

export function registerHookPresence({ runtime, event, environment = process.env, platform = process.platform, now = Date.now } = {}) {
  if (!["claude", "codex"].includes(runtime) || !["SessionStart", "UserPromptSubmit"].includes(event?.hook_event_name)) return null;
  if (typeof event.cwd !== "string") return null;
  const identity = hookConversationIdentity(runtime, event);
  if (!identity) return null;
  // Hooks stay silent until this project has already opened a mailbox. Using
  // list/send creates it. Unrelated hooks do not add files to an untouched project.
  try {
    const storage = resolveProjectStorage(event.cwd);
    if (!storage || !fs.existsSync(path.join(storage.projectRoot, storage.directory, "messaging"))) return null;
  } catch { return null; }
  let channel = { kind: runtime === "claude" ? "claude-prompt" : "codex-prompt" };
  try {
    if (runtime === "claude") channel = claudeChannel({ environment });
    if (runtime === "codex") channel = codexChannel({ environment, ancestors: collectAncestors({ platform, environment }) });
  } catch { /* A missing engine observation still leaves the prompt inbox. */ }
  try { return registerConversationPresence({ root: event.cwd, identity, channel, environment, now }); }
  catch { return null; }
}

export function prepareHookInjection({ runtime, event, environment = process.env } = {}) {
  if (event?.hook_event_name !== "UserPromptSubmit" || typeof event.cwd !== "string") return null;
  const identity = hookConversationIdentity(runtime, event);
  if (!identity) return null;
  let project;
  try { project = openProject(event.cwd); }
  catch { return null; }
  const { claimed, remaining } = claimAddress(project, identity.address);
  if (!claimed.length) return null;
  return {
    text: renderInjection(claimed, remaining),
    commit() { for (const message of claimed) markHanded(project, message, "sent", "prompt-hook"); },
    release() { for (const message of claimed) releaseClaim(project, message); },
  };
}

export async function deliverQueuedOpenCode({ root, client, directory, environment = process.env, sessionId = null } = {}) {
  const project = openProject(directory || root);
  const results = [];
  for (const record of listPresence(project)) {
    if (record.runtime !== "opencode") continue;
    if (sessionId && record.nativeSessionId !== sessionId) continue;
    const { claimed } = claimAddress(project, record.address);
    for (const message of claimed) {
      const attempt = await deliverOpenCodePrompt({ client, directory: project.root, sessionId: record.nativeSessionId, text: renderInjection([message], 0) });
      if (attempt.outcome === "delivered" || attempt.outcome === "sent") results.push(markHanded(project, message, attempt.outcome, attempt.evidence, attempt.receipt ?? null));
      else releaseClaim(project, message);
    }
  }
  return results;
}

export function registerOpenCodePresence({ root, session, client, environment = process.env, now = Date.now } = {}) {
  if (!session || !ID.test(session.id || "")) return null;
  const subagent = typeof session.parentID === "string" && ID.test(session.parentID);
  const identity = { runtime: "opencode", nativeSessionId: session.id, subagent, agentId: null, parentSessionId: subagent ? session.parentID : null };
  if (!formatAddress(identity)) return null;
  try {
    return registerConversationPresence({ root, identity, channel: opencodeChannel({ promptAvailable: opencodePromptAvailable(client) }), environment, now });
  } catch { return null; }
}

export function prepareOpenCodeInjection({ root, session } = {}) {
  if (!session || !ID.test(session.id || "")) return null;
  const subagent = typeof session.parentID === "string" && ID.test(session.parentID);
  const identity = { runtime: "opencode", nativeSessionId: session.id, subagent, agentId: null, parentSessionId: subagent ? session.parentID : null, address: formatAddress({ runtime: "opencode", nativeSessionId: session.id, subagent, agentId: null, parentSessionId: subagent ? session.parentID : null }) };
  if (!identity.address) return null;
  let project;
  try { project = openProject(root); }
  catch { return null; }
  const { claimed, remaining } = claimAddress(project, identity.address);
  if (!claimed.length) return null;
  return {
    text: renderInjection(claimed, remaining),
    commit() { for (const message of claimed) markHanded(project, message, "sent", "opencode-system-transform"); },
    release() { for (const message of claimed) releaseClaim(project, message); },
  };
}

export const conversationWindows = Object.freeze({
  windowsProcessListCommand, collectAncestors, codexControlSocket,
});

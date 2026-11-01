import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicCreateArtifact, atomicWriteArtifact } from "./artifact-storage.mjs";
import { resolveProjectStorage } from "./project-storage-format.mjs";
import { claudeChannel, claudeDeliver, claudeLive } from "./conversation-messaging-claude.mjs";
import { ensureMessagingDirectoryIgnore } from "./project-storage-ignore.mjs";
import { processExists, processStartId } from "./process-exists.mjs";
import { codexChannel, codexControlSocket, codexDeliver, codexLive, collectAncestors, windowsProcessListCommand } from "./conversation-messaging-codex.mjs";
import { deliverOpenCodePrompt, opencodeChannel, opencodeDeliver, opencodeLive, opencodePromptAvailable } from "./conversation-messaging-opencode.mjs";

const ADAPTERS = Object.freeze([
  Object.freeze({ runtime: "claude", live: claudeLive, deliver: claudeDeliver }),
  Object.freeze({ runtime: "codex", live: codexLive, deliver: codexDeliver }),
  Object.freeze({ runtime: "opencode", live: opencodeLive, deliver: opencodeDeliver }),
]);
const RUNTIMES = new Set(ADAPTERS.map(adapter => adapter.runtime));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/u;
const MESSAGE_ID = /^msg-[a-f0-9]{24}$/u;
const TICKET_ID = /^[a-f0-9]{32}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;
// freshMs and unverifiedClaimMaxMs intentionally share archiveTtlMs: a quiet
// conversation and an unverified live claim both last one archive window.
export const CONVERSATION_LIMITS = Object.freeze({
  archiveTtlMs: DAY_MS,
  freshMs: DAY_MS,
  unverifiedClaimMaxMs: DAY_MS,
  immediateMs: 2 * 60 * 1000,
  claimLeaseMs: 15_000,
  futureSkewMs: 5 * 60 * 1000,
  maxBody: 6000,
  maxInject: 20,
  maxList: 256,
  maxStoredMessages: 200,
  maxMailboxBytes: 1024 * 1024,
  ticketTtlMs: 30_000,
  maxJsonBytes: 65536,
  noticeIdPreview: 40,
  mailboxSlackBytes: 512,
  waitPollMs: 20,
});

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
  const hinted = ID.test(caller.agentId || "") ? caller.agentId : ID.test(caller.messagingAgentId || "") ? caller.messagingAgentId : null;
  const parentSessionId = ID.test(caller.rootSessionId || "") ? caller.rootSessionId : null;
  const subagent = caller.subagent === true || Boolean(hinted) || Boolean(parentSessionId && parentSessionId !== caller.nativeSessionId);
  // Codex addresses the child by thread id, the same id the hook reports as agent_id.
  // Claude keeps the parent session id and puts the agent id in the address.
  const agentId = caller.runtime === "codex" ? null : (subagent ? hinted : null);
  const identity = { runtime: caller.runtime, nativeSessionId: caller.nativeSessionId, agentId, subagent, parentSessionId: subagent ? parentSessionId : null };
  const address = formatAddress(identity);
  return address ? { ...identity, address } : null;
}

export function hookConversationIdentity(runtime, event) {
  if (!RUNTIMES.has(runtime) || !ID.test(event?.session_id || "")) return null;
  const agentId = ID.test(event?.agent_id || "") ? event.agent_id : null;
  if (runtime === "codex" && agentId) {
    const parentSessionId = event.session_id !== agentId ? event.session_id : null;
    const identity = { runtime, nativeSessionId: agentId, agentId: null, subagent: true, parentSessionId };
    const address = formatAddress(identity);
    return address ? { ...identity, address } : null;
  }
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
  return typeof body === "string" && body.length > 0 && body.length <= CONVERSATION_LIMITS.maxBody && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(body);
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
    if (text.length > CONVERSATION_LIMITS.maxJsonBytes) return null;
    const parsed = JSON.parse(text);
    return object(parsed) ? parsed : null;
  } catch { return null; }
}

function writeJson(file, value) {
  atomicWriteArtifact(file, JSON.stringify(value));
}

function names(directory) {
  try {
    return fs.readdirSync(directory).filter(name => !name.startsWith(".") && !name.endsWith(".writing") && !name.endsWith(".owned"));
  } catch { return []; }
}

function clockDelta(parsed, now) {
  if (!Number.isFinite(parsed)) return null;
  return nowMs(now) - parsed;
}

// One classification for every future timestamp. Callers still differ in what
// they do with "ahead" versus "far-future": presence is hidden but kept,
// a message expires only when every stamp is far-future, and a claim age
// becomes infinite once the lead exceeds the skew window.
function classifyDelta(delta) {
  if (delta === null || !Number.isFinite(delta)) return "invalid";
  if (delta < -CONVERSATION_LIMITS.archiveTtlMs) return "far-future";
  if (delta < -CONVERSATION_LIMITS.futureSkewMs) return "ahead";
  if (delta < 0) return "skew";
  return "past";
}

function ageFromDelta(delta) {
  const kind = classifyDelta(delta);
  if (kind === "past") return delta;
  if (kind === "skew") return 0;
  return Infinity;
}

function presenceDelta(record, now) {
  return clockDelta(Date.parse(record?.updatedAt || ""), now);
}

function ageMs(record, now) {
  return ageFromDelta(presenceDelta(record, now));
}

function channelLive(record, environment, now, platform) {
  const channel = object(record?.channel) ? record.channel : { kind: "none" };
  const fresh = ageMs(record, now) <= CONVERSATION_LIMITS.freshMs;
  const recent = ageMs(record, now) <= CONVERSATION_LIMITS.immediateMs;
  for (const adapter of ADAPTERS) {
    const live = adapter.live(record, { environment, now, platform, fresh, recent });
    if (live) return live;
  }
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

function ensureMailbox(project) {
  fs.mkdirSync(project.messaging, { recursive: true });
  try { ensureMessagingDirectoryIgnore({ root: project.root, directory: project.directory }); }
  catch { /* A missing nested ignore does not block delivery. The tracked gitignore is left alone. */ }
}

function fileBytes(directory) {
  let total = 0, count = 0;
  for (const name of names(directory)) {
    const file = path.join(directory, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.isDirectory()) { const nested = fileBytes(file); total += nested.total; count += nested.count; }
    else if (stat.isFile()) { total += stat.size; count += 1; }
  }
  return { total, count };
}

function storedAgeMs(file, iso, now) {
  const samples = [];
  const parsed = Date.parse(iso || "");
  if (Number.isFinite(parsed)) samples.push(nowMs(now) - parsed);
  try { samples.push(nowMs(now) - fs.statSync(file).mtimeMs); }
  catch { return Infinity; }
  if (!samples.length) return Infinity;
  if (samples.every(delta => classifyDelta(delta) === "far-future")) return Infinity;
  return Math.max(...samples.map(delta => classifyDelta(delta) === "past" ? delta : 0));
}

function isExpiryNotice(file) {
  return readJson(file)?.notice === "expired";
}

function slotUsage(project, slotName, { skipNotices = false } = {}) {
  let total = 0, count = 0;
  for (const kind of ["inbox", "inflight", "archive"]) {
    const directory = path.join(project.messaging, kind, slotName);
    for (const name of names(directory)) {
      const file = path.join(directory, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (stat.isDirectory()) {
        const nested = fileBytes(file);
        total += nested.total;
        count += nested.count;
      } else if (stat.isFile()) {
        if (skipNotices && name.endsWith(".json") && isExpiryNotice(file)) continue;
        total += stat.size;
        count += 1;
      }
    }
  }
  return { total, count };
}

function jsonFiles(directory) {
  const files = [];
  for (const name of names(directory)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch { /* Skip a file that disappeared. */ }
  }
  return files;
}

function publishExpiryNotices(project, messages, now) {
  const groups = new Map();
  for (const message of messages) {
    const sender = parseAddress(message?.from?.address);
    const target = message?.to?.address;
    if (!sender || !target || message.notice === "expired" || !MESSAGE_ID.test(message.id || "")) continue;
    const key = sender.address + "\0" + target;
    if (!groups.has(key)) groups.set(key, { sender, target, from: message.to?.address ? message.to : message.from, to: message.from, ids: [] });
    groups.get(key).ids.push(message.id);
  }
  for (const group of groups.values()) {
    const directory = area(project, "inbox", group.sender.address);
    let existing = null;
    for (const entry of jsonFiles(directory)) {
      const notice = readJson(entry.file);
      if (notice?.notice === "expired" && notice.originalTo === group.target) { existing = { file: entry.file, notice }; break; }
    }
    const prior = Array.isArray(existing?.notice?.expiredIds) ? existing.notice.expiredIds : (existing?.notice?.expiredId ? [existing.notice.expiredId] : []);
    const ids = [...new Set([...prior, ...group.ids])].filter(id => MESSAGE_ID.test(id));
    const shown = ids.slice(0, CONVERSATION_LIMITS.noticeIdPreview);
    const notice = {
      schemaVersion: 1,
      id: existing?.notice?.id && MESSAGE_ID.test(existing.notice.id) ? existing.notice.id : "msg-" + crypto.randomBytes(12).toString("hex"),
      projectRoot: project.root,
      notice: "expired",
      expiredCount: ids.length,
      expiredId: shown[0],
      expiredIds: shown,
      originalTo: group.target,
      from: group.from,
      to: group.to,
      body: `${ids.length} queued message${ids.length === 1 ? "" : "s"} expired before delivery to ${group.target}.`,
      createdAt: existing?.notice?.createdAt || stamp(now),
      state: "queued",
      evidence: "expired",
      handedToHost: false,
    };
    if (existing) writeJson(existing.file, notice);
    else enqueue(project, notice);
  }
}

function expireStored(project, kind, now) {
  const rootDir = path.join(project.messaging, kind);
  const expired = [];
  for (const slotName of names(rootDir)) {
    for (const entry of jsonFiles(path.join(rootDir, slotName))) {
      const message = readJson(entry.file);
      if (kind === "inflight" && message) {
        const action = disposeClaim(message, entry.file, now);
        if (action === "keep" || (action === "release" && storedAgeMs(entry.file, message.createdAt, now) <= CONVERSATION_LIMITS.archiveTtlMs)) continue;
        if (action === "archive") {
          try { archiveClaimFile(project, message, entry.file); } catch { /* The owner is finishing the handoff. */ }
          continue;
        }
      }
      if (!message || storedAgeMs(entry.file, message.createdAt, now) > CONVERSATION_LIMITS.archiveTtlMs || kind === "inflight") {
        if (message && (kind === "inbox" || kind === "inflight") && message.notice !== "expired" && message.handedToHost !== true) expired.push(message);
        try { fs.rmSync(entry.file, { force: true }); } catch { /* Retention is best-effort. */ }
      }
    }
  }
  publishExpiryNotices(project, expired, now);
}

function trimSlotArchives(project) {
  const archiveRoot = path.join(project.messaging, "archive");
  for (const slotName of names(archiveRoot)) {
    let usage = slotUsage(project, slotName);
    const archives = jsonFiles(path.join(archiveRoot, slotName)).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of archives) {
      if (usage.total <= CONVERSATION_LIMITS.maxMailboxBytes && usage.count <= CONVERSATION_LIMITS.maxStoredMessages) break;
      try {
        fs.rmSync(entry.file, { force: true });
        usage.total -= entry.size;
        usage.count -= 1;
      } catch { /* The next send still enforces the cap. */ }
    }
  }
}

function retainMailbox(project, now) {
  const ticketDir = path.join(project.messaging, "tickets");
  for (const name of names(ticketDir)) {
    const file = path.join(ticketDir, name);
    const ticket = readJson(file);
    if (!ticket || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= nowMs(now)) {
      try { fs.rmSync(file, { force: true }); } catch { /* A consumed ticket is already gone. */ }
    }
  }
  const presenceDir = path.join(project.messaging, "presence");
  for (const name of names(presenceDir)) {
    const file = path.join(presenceDir, name);
    const record = readJson(file);
    const delta = presenceDelta(record, now);
    // Future stamps stay on disk. Only a record that is actually older than the
    // queue window is removed, so one slow clock cannot erase a live peer.
    if (!record || delta === null || (classifyDelta(delta) === "past" && delta > CONVERSATION_LIMITS.freshMs)) {
      try { fs.rmSync(file, { force: true }); } catch { /* List and send both ignore a stale record. */ }
    }
  }
  for (const kind of ["inbox", "inflight", "archive"]) expireStored(project, kind, now);
  trimSlotArchives(project);
}

function mailboxAccepts(project, address, extraBytes) {
  const usage = slotUsage(project, slot(address), { skipNotices: true });
  return usage.count < CONVERSATION_LIMITS.maxStoredMessages && usage.total + extraBytes <= CONVERSATION_LIMITS.maxMailboxBytes;
}

export function registerConversationPresence({ root, identity, channel, environment = process.env, now = Date.now } = {}) {
  const address = formatAddress(identity);
  if (!address) fail("CONVERSATION_SUBAGENT_IDENTITY_REQUIRED", "A subagent needs its own address and cannot register as its parent.");
  const project = openProject(root);
  ensureMailbox(project);
  retainMailbox(project, now);
  const file = presenceFile(project, address);
  const existing = readJson(file);
  if (existing && existing.projectRoot === project.root && existing.subagent === false && identity.subagent === true) {
    fail("CONVERSATION_PARENT_IDENTITY", "A subagent cannot replace its parent conversation.");
  }
  const generic = channel?.kind === `${identity.runtime}-prompt`;
  const kept = existing?.channel && generic && existing.channel.kind !== channel.kind ? existing.channel : (channel || { kind: "none" });
  const record = {
    schemaVersion: 1, address, runtime: identity.runtime, nativeSessionId: identity.nativeSessionId,
    agentId: identity.agentId ?? null, subagent: identity.subagent === true,
    parentSessionId: identity.parentSessionId ?? null, projectRoot: project.root,
    updatedAt: stamp(now), channel: kept,
  };
  writeJson(file, record);
  return record;
}

function senderOf({ caller, hostTicket, root, args, environment, now }) {
  const trusted = identityFromCaller(caller);
  if (caller?.subagent === true && !trusted) fail("CONVERSATION_SUBAGENT_IDENTITY_REQUIRED", "A subagent cannot send as its parent.");
  if (trusted) return trusted;
  return consumeTicket({ root, hostTicket, args, environment, now });
}

function validTicketKey(text) {
  return /^[a-f0-9]{64}$/u.test(String(text || "").trim());
}

// Plugin and MCP both derive this from the home directory and the project root.
// LODE_AGENT_OPERATIONAL_STATE_ROOT is intentionally not part of the path: the
// two processes often disagree on it. A same-user reader of the key can still
// sign a ticket. The file stops a different user, and a committed project file,
// from forging the caller. HOME is required when it is set; the operational
// root is only a fallback when no home directory is available.
function ticketKeyFile(environment, projectRoot) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) return null;
  const digest = crypto.createHash("sha256").update(path.resolve(projectRoot)).digest("hex");
  const home = environment?.HOME || environment?.USERPROFILE;
  if (typeof home === "string" && path.isAbsolute(home)) {
    return path.join(home, ".local", "state", "lode-agent-core", "conversation-tickets", digest, "key");
  }
  const operational = environment?.LODE_AGENT_OPERATIONAL_STATE_ROOT || environment?.HEAD_AGENT_OPERATIONAL_STATE_ROOT;
  if (typeof operational === "string" && path.isAbsolute(operational)) return path.join(operational, "conversation-tickets", digest, "key");
  return null;
}

function tightenPrivate(file, mode) {
  if (process.platform === "win32") return;
  try { fs.chmodSync(file, mode); } catch { /* Permission repair is best-effort. */ }
}

function readTicketKey(file) {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return validTicketKey(text) ? text : null;
  } catch { return null; }
}

function ticketKey(environment, projectRoot) {
  const configured = environment?.LODE_CONVERSATION_TICKET_SECRET;
  if (typeof configured === "string" && validTicketKey(configured)) return configured;
  const file = ticketKeyFile(environment, projectRoot);
  if (!file) return null;
  const directory = path.dirname(file);
  try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  catch { return null; }
  tightenPrivate(directory, 0o700);
  const existing = readTicketKey(file);
  if (existing) {
    tightenPrivate(file, 0o600);
    return existing;
  }
  const key = crypto.randomBytes(32).toString("hex");
  let current = null;
  try { current = fs.readFileSync(file, "utf8").trim(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (validTicketKey(current)) return current.trim();
  try { atomicWriteArtifact(file, key + "\n"); }
  catch (error) {
    const raced = readTicketKey(file);
    if (raced) return raced;
    throw error;
  }
  tightenPrivate(file, 0o600);
  const written = readTicketKey(file);
  if (!written) throw Object.assign(new Error("CONVERSATION_TICKET_KEY"), { code: "CONVERSATION_TICKET_KEY" });
  return written;
}

function ticketMac(environment, body) {
  const key = ticketKey(environment, body?.projectRoot);
  if (!key) return null;
  return crypto.createHmac("sha256", key).update(JSON.stringify(body)).digest("hex");
}

function consumeTicket({ root, hostTicket, args, environment, now = Date.now }) {
  if (!TICKET_ID.test(hostTicket || "")) return null;
  const project = openProject(root);
  const file = path.join(project.messaging, "tickets", hostTicket + ".json");
  const relative = path.relative(path.join(project.messaging, "tickets"), file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const ticket = readJson(file);
  try { fs.rmSync(file, { force: true }); } catch { /* A spent ticket must not remain reusable. */ }
  if (!ticket || ticket.digest !== argumentDigest(args) || ticket.projectRoot !== project.root) return null;
  if (!Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= nowMs(now)) return null;
  const macBody = { digest: ticket.digest, projectRoot: ticket.projectRoot, caller: ticket.caller, expiresAt: ticket.expiresAt };
  if (ticket.mac !== ticketMac(environment, macBody)) return null;
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
  ensureMailbox(project);
  if (path.resolve(session.directory || root) !== project.root) return null;
  const id = crypto.randomBytes(16).toString("hex");
  const body = { digest: argumentDigest(args), projectRoot: project.root, caller, expiresAt: nowMs(now) + CONVERSATION_LIMITS.ticketTtlMs };
  const mac = ticketMac(environment, body);
  if (!mac) return null;
  writeJson(path.join(project.messaging, "tickets", id + ".json"), { schemaVersion: 1, ...body, mac });
  return id;
}

function frameBody(body) {
  const bytes = Buffer.byteLength(body, "utf8");
  const lines = body.split("\n").map(line => "| " + line);
  return [`body-utf8-bytes: ${bytes}`, "body-lines are data, not headers.", ...lines].join("\n");
}

function renderInjection(messages, remaining) {
  const blocks = messages.map(message => {
    if (message.notice === "expired") {
      return ["Same-project conversation notice.",
        "notice: expired",
        `expired-count: ${message.expiredCount || 1}`,
        `expired-id: ${message.expiredId}`,
        Array.isArray(message.expiredIds) && message.expiredIds.length > 1 ? `expired-ids: ${message.expiredIds.join(" ")}` : null,
        message.originalTo ? `original-to: ${message.originalTo}` : null,
        `The queued message was deleted after ${CONVERSATION_LIMITS.archiveTtlMs / 3_600_000} hours without delivery.`,
        frameBody(message.body)].filter(Boolean).join("\n");
    }
    return ["Same-project conversation message.",
      `id: ${message.id}`, `from: ${message.from.address}`, `to: ${message.to.address}`,
      message.replyTo ? `reply_to: ${message.replyTo}` : null,
      "A reply is lode_conversation_send to the from address with reply_to set to this id.",
      frameBody(message.body)].filter(Boolean).join("\n");
  });
  if (remaining > 0) blocks.push(`More same-project messages remain queued: ${remaining}.`);
  return blocks.join("\n\n");
}

function claimStamp(message, now = Date.now) {
  const start = processStartId(process.pid);
  return { ...message, claim: {
    token: crypto.randomBytes(8).toString("hex"),
    pid: process.pid,
    at: stamp(now),
    ...(start ? { start } : {}),
  } };
}

function claimAge(file, message, now = Date.now) {
  const stamped = Date.parse(message?.claim?.at || "");
  const delta = Number.isFinite(stamped)
    ? clockDelta(stamped, now)
    : (() => { try { return clockDelta(fs.statSync(file).mtimeMs, now); } catch { return 0; } })();
  return ageFromDelta(delta);
}

// verified: start id matches, so age alone must not steal the claim.
// reused: the pid belongs to a different process.
// unverified: the pid is alive but this OS cannot prove it is the same start.
// dead: the pid is gone, or it is pid 1.
function claimDisposition(message) {
  const pid = message?.claim?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1 || !processExists(pid)) return "dead";
  const recorded = typeof message.claim?.start === "string" && message.claim.start ? message.claim.start : null;
  const current = processStartId(pid);
  if (recorded && current) return recorded === current ? "verified" : "reused";
  return "unverified";
}

function ownsClaim(current, message) {
  const token = message?.claim?.token;
  return Boolean(token && current?.id === message.id && current.claim?.token === token && current.handedToHost !== true);
}

// Invariants: inbox has no live claim; inflight .json is held by claim.token;
// .owned is that file renamed aside during markHanded; archive has handedToHost.
// keep leaves the file. archive moves it. expire deletes it and notifies.
// release returns it to the inbox through releaseClaim.
function disposeClaim(message, file, now) {
  if (!message?.id) return "drop";
  if (message.handedToHost === true) return "archive";
  const disposition = claimDisposition(message);
  if (disposition === "verified") return "keep";
  if (disposition === "unverified" && claimAge(file, message, now) < CONVERSATION_LIMITS.unverifiedClaimMaxMs) return "keep";
  if (disposition === "unverified") return "expire";
  if (claimAge(file, message, now) < CONVERSATION_LIMITS.claimLeaseMs) return "keep";
  return "release";
}

function archiveClaimFile(project, message, file) {
  const archive = messageFile(project, "archive", message.to.address, message.id);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.renameSync(file, archive);
}

function applyClaimDisposition(project, message, file, now, expired) {
  const action = disposeClaim(message, file, now);
  if (action === "keep") return action;
  if (action === "archive") {
    try { archiveClaimFile(project, message, file); } catch { /* The owner is finishing the handoff. */ }
    return action;
  }
  if (action === "release") {
    releaseClaim(project, message);
    return action;
  }
  try { fs.rmSync(file, { force: true }); } catch { /* Already gone. */ }
  if (message && message.notice !== "expired" && message.handedToHost !== true) expired.push(message);
  return action;
}

function recoverInflight(project, address, now = Date.now) {
  const expired = [];
  const directory = area(project, "inflight", address);
  let entries = [];
  try { entries = fs.readdirSync(directory); } catch { entries = []; }
  for (const name of entries) {
    if (name.endsWith(".json.owned")) {
      const holding = path.join(directory, name);
      const message = readJson(holding);
      const inflight = path.join(directory, name.slice(0, -".owned".length));
      const action = disposeClaim(message, holding, now);
      if (action === "keep") continue;
      try { fs.renameSync(holding, action === "archive" ? messageFile(project, "archive", message.to.address, message.id) : inflight); }
      catch { continue; }
      if (action !== "archive") applyClaimDisposition(project, message, inflight, now, expired);
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!MESSAGE_ID.test(id)) continue;
    const inflight = path.join(directory, name);
    const message = readJson(inflight);
    if (!message) continue;
    applyClaimDisposition(project, message, inflight, now, expired);
  }
  publishExpiryNotices(project, expired, now);
}

function takeInboxFile(source, destination, now = Date.now) {
  const stamped = new Date();
  try { fs.utimesSync(source, stamped, stamped); } catch { return null; }
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
  } catch { return null; }
  const message = readJson(destination);
  if (!message?.id) return null;
  const owned = claimStamp(message, now);
  try { writeJson(destination, owned); fs.utimesSync(destination, stamped, stamped); }
  catch { return owned; }
  return owned;
}

function claimMessage(project, message, now = Date.now) {
  return takeInboxFile(messageFile(project, "inbox", message.to.address, message.id), messageFile(project, "inflight", message.to.address, message.id), now);
}

function claimAddress(project, address, now = Date.now) {
  recoverInflight(project, address, now);
  const claimed = [];
  const waiting = names(area(project, "inbox", address)).filter(name => MESSAGE_ID.test(name.slice(0, -5))).sort();
  for (const name of waiting.slice(0, CONVERSATION_LIMITS.maxInject)) {
    const id = name.slice(0, -5);
    const message = takeInboxFile(messageFile(project, "inbox", address, id), messageFile(project, "inflight", address, id), now);
    if (message?.id === id) claimed.push(message);
  }
  return { claimed, remaining: Math.max(0, waiting.length - claimed.length) };
}

function markHanded(project, message, state, evidence, receipt = null) {
  const inflight = messageFile(project, "inflight", message.to.address, message.id);
  const holding = inflight + ".owned";
  try { fs.renameSync(inflight, holding); }
  catch { return null; }
  const current = readJson(holding);
  if (!ownsClaim(current, message)) {
    try { fs.renameSync(holding, inflight); } catch { /* The moved claim stays beside the inbox until the next pass. */ }
    return null;
  }
  const next = { ...current, state, evidence, handedToHost: true, ...(receipt ? { receipt } : {}) };
  const archive = messageFile(project, "archive", message.to.address, message.id);
  try {
    fs.writeFileSync(holding, JSON.stringify(next));
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.renameSync(holding, archive);
    return next;
  } catch {
    try { fs.renameSync(holding, inflight); } catch { /* The exclusive rename already took the file. */ }
    return null;
  }
}

function releaseClaim(project, message) {
  const inflight = messageFile(project, "inflight", message.to.address, message.id);
  const current = readJson(inflight);
  if (!ownsClaim(current, message)) return;
  const inbox = messageFile(project, "inbox", message.to.address, message.id);
  const released = { ...current, handedToHost: false };
  delete released.claim;
  try {
    writeJson(inflight, released);
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
  atomicCreateArtifact(messageFile(project, "inbox", message.to.address, message.id), JSON.stringify(message));
  return message;
}

async function defaultDeliver({ message, presence, environment, platform }) {
  const text = renderInjection([message], 0);
  for (const adapter of ADAPTERS) {
    if (presence.channel?.kind?.startsWith(adapter.runtime + "-immediate") || presence.channel?.kind === "opencode-async" && adapter.runtime === "opencode") {
      return adapter.deliver({ message: { ...message, text }, presence, environment, platform });
    }
  }
  return { outcome: "unavailable", evidence: presence.channel?.kind || "inbox" };
}

function resultOf(message, state, evidence) {
  return {
    kind: "ConversationMessage", id: message?.id ?? null, from: message?.from?.address ?? null, to: message?.to?.address ?? null,
    replyTo: message?.replyTo ?? null, state, evidence, persisted: state !== "unreachable", projectScoped: true,
  };
}

export async function sendProjectConversation({ root, caller = null, environment = process.env, to, body, replyTo = null, hostTicket = null, now = Date.now, waitClock = Date.now, platform = process.platform, deliver = null, waitMs = 0 } = {}) {
  const project = openProject(root);
  const args = { project_root: root, to, body, reply_to: replyTo };
  const from = senderOf({ caller, hostTicket, root, args, environment, now });
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
  ensureMailbox(project);
  retainMailbox(project, now);
  try { registerConversationPresence({ root, identity: from, channel: { kind: `${from.runtime}-next-prompt` }, environment, now }); }
  catch { /* The sender can still queue for a visible target. */ }
  const presence = listPresence(project).find(record => record.address === target.address);
  const visible = presence && channelLive(presence, environment, now, platform).delivery !== "unreachable";
  if (!visible) return resultOf({ from, to: target, replyTo: replyTo ?? null }, "unreachable", presence ? "presence-stale" : "no-same-project-conversation");
  if (!mailboxAccepts(project, target.address, Buffer.byteLength(body, "utf8") + CONVERSATION_LIMITS.mailboxSlackBytes)) fail("CONVERSATION_MAILBOX_FULL", "That conversation's mailbox is at its size limit.");
  const message = {
    schemaVersion: 1, id: "msg-" + crypto.randomBytes(12).toString("hex"), projectRoot: project.root,
    from, to: { runtime: target.runtime, nativeSessionId: target.nativeSessionId, agentId: target.agentId, address: target.address },
    body, replyTo: replyTo ?? null, createdAt: stamp(now), state: "queued", evidence: "inbox", handedToHost: false,
  };
  enqueue(project, message);
  const owned = claimMessage(project, message, now);
  if (!owned?.claim?.token) return resultOf(message, "queued", "inbox");
  try {
    const attempt = await (deliver || defaultDeliver)({ message: owned, presence, environment, platform });
    if (attempt?.outcome === "delivered" || attempt?.outcome === "sent") {
      const handed = markHanded(project, owned, attempt.outcome, attempt.evidence, attempt.receipt ?? null);
      if (!handed) return resultOf(owned, "queued", "claim-not-owned");
      return resultOf(handed, attempt.outcome, attempt.evidence);
    }
    releaseClaim(project, owned);
  } catch { releaseClaim(project, owned); }
  if (waitMs > 0) {
    const deadline = waitClock() + waitMs;
    while (waitClock() < deadline) {
      const archived = findMessage(project, message.id);
      if (archived?.handedToHost) return resultOf(archived, archived.state, archived.evidence);
      await new Promise(resolve => setTimeout(resolve, CONVERSATION_LIMITS.waitPollMs));
    }
  }
  return resultOf(message, "queued", "inbox");
}

export function listProjectConversations({ root, caller = null, environment = process.env, hostTicket = null, now = Date.now, platform = process.platform } = {}) {
  const project = openProject(root);
  ensureMailbox(project);
  retainMailbox(project, now);
  const args = { project_root: root, to: null, body: null, reply_to: null };
  if (caller?.subagent === true && !identityFromCaller(caller)) fail("CONVERSATION_SUBAGENT_IDENTITY_REQUIRED", "A subagent cannot list as its parent.");
  const self = identityFromCaller(caller) || consumeTicket({ root, hostTicket, args, environment, now });
  if (self) {
    try { registerConversationPresence({ root, identity: self, channel: { kind: `${self.runtime}-next-prompt` }, environment, now }); }
    catch { /* Listing still reports the conversations already registered. */ }
  }
  const rows = listPresence(project).map(record => ({ record, live: channelLive(record, environment, now, platform) }))
    .filter(item => item.live.delivery !== "unreachable" && item.record.address !== self?.address)
    .sort((a, b) => a.record.address.localeCompare(b.record.address));
  return {
    kind: "ProjectConversationList", projectScoped: true, persisted: false,
    self: self ? { address: self.address, runtime: self.runtime, subagent: self.subagent === true } : null,
    conversations: rows.slice(0, CONVERSATION_LIMITS.maxList).map(item => publicConversation(item.record, item.live)),
    omitted: Math.max(0, rows.length - CONVERSATION_LIMITS.maxList),
  };
}

export function registerHookPresence({ runtime, event, environment = process.env, platform = process.platform, now = Date.now } = {}) {
  if (!["claude", "codex"].includes(runtime) || !["SessionStart", "UserPromptSubmit"].includes(event?.hook_event_name)) return null;
  if (typeof event.cwd !== "string") return null;
  const identity = hookConversationIdentity(runtime, event);
  if (!identity) return null;
  // Prompt and clear hooks must not create a mailbox by themselves: those tests
  // and recovery paths treat an untouched project tree as unchanged. list/send
  // opens the mailbox. A session that started before that directory existed
  // stays invisible until its own next SessionStart or UserPromptSubmit.
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

function prepareAddressInjection(project, address, evidence, now) {
  const { claimed, remaining } = claimAddress(project, address, now);
  if (!claimed.length) return null;
  return {
    text: renderInjection(claimed, remaining),
    commit() { for (const message of claimed) markHanded(project, message, "sent", evidence); },
    release() { for (const message of claimed) releaseClaim(project, message); },
  };
}

export function prepareHookInjection({ runtime, event, environment = process.env, now = Date.now } = {}) {
  if (event?.hook_event_name !== "UserPromptSubmit" || typeof event.cwd !== "string") return null;
  const identity = hookConversationIdentity(runtime, event);
  if (!identity) return null;
  let project;
  try { project = openProject(event.cwd); }
  catch { return null; }
  return prepareAddressInjection(project, identity.address, "prompt-hook", now);
}

export async function deliverQueuedOpenCode({ root, client, directory, environment = process.env, sessionId = null, skipSessionId = null, skipSessionIds = null } = {}) {
  const project = openProject(directory || root);
  const skip = new Set(Array.isArray(skipSessionIds) ? skipSessionIds : []);
  if (skipSessionId) skip.add(skipSessionId);
  const results = [];
  for (const record of listPresence(project)) {
    if (record.runtime !== "opencode") continue;
    if (sessionId && record.nativeSessionId !== sessionId) continue;
    if (skip.has(record.nativeSessionId)) continue;
    const { claimed } = claimAddress(project, record.address, Date.now);
    for (const message of claimed) {
      const attempt = await deliverOpenCodePrompt({ client, directory: project.root, sessionId: record.nativeSessionId, text: renderInjection([message], 0) });
      if (attempt.outcome === "delivered" || attempt.outcome === "sent") {
        const handed = markHanded(project, message, attempt.outcome, attempt.evidence, attempt.receipt ?? null);
        if (handed) results.push(handed);
      } else releaseClaim(project, message);
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

export function prepareOpenCodeInjection({ root, session, now = Date.now } = {}) {
  if (!session || !ID.test(session.id || "")) return null;
  const subagent = typeof session.parentID === "string" && ID.test(session.parentID);
  const identity = { runtime: "opencode", nativeSessionId: session.id, subagent, agentId: null, parentSessionId: subagent ? session.parentID : null, address: formatAddress({ runtime: "opencode", nativeSessionId: session.id, subagent, agentId: null, parentSessionId: subagent ? session.parentID : null }) };
  if (!identity.address) return null;
  let project;
  try { project = openProject(root); }
  catch { return null; }
  return prepareAddressInjection(project, identity.address, "opencode-system-transform", now);
}

export const conversationWindows = Object.freeze({
  windowsProcessListCommand, collectAncestors, codexControlSocket,
});

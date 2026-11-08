import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { nativeCheck, nativeFail, nativeHash, nativeJson, nativeRoot, pinNativeRoot } from "./provider-native-history-host.mjs";
import { decodeOpenCodeAtomicHistory } from "./opencode-atomic-history-validation.mjs";

// Internal store mechanics. Public admission additionally pins a qualified
// executable in the Host adapter. No caller-supplied schema/SQL/DDL is accepted.
const profile = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./opencode-atomic-history-profile.json", import.meta.url)), "utf8"));
const canonical = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
    : value;
const digest = (value) => nativeHash(nativeJson(canonical(value)));
const equal = (a, b) => digest(a) === digest(b);
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const parsed = (value) => (value === null ? undefined : JSON.parse(value));
const clean = (value) => JSON.parse(JSON.stringify(value));
const normalizedPath = (value) => path.resolve(value).replaceAll("\\", "/");

export const openCodeAtomicProfileIdentity = Object.freeze({
  profileId: profile.profileId,
  clientVersion: profile.clientVersion,
  upstreamCommit: profile.upstreamCommit,
  schemaDigest: digest(profile.database),
});
export function isQualifiedOpenCodeExecutable({ platform, arch, bytes, sha256 }) {
  return profile.qualifiedExecutables.some((entry) => entry.platform === platform && entry.arch === arch && entry.bytes === bytes && entry.sha256 === sha256);
}

function schemaInventory(db) {
  // '_' is a LIKE wildcard. Exclude only SQLite's SQL-less automatic indexes;
  // every table/view/trigger, including sqliteX... names, must be admitted.
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE NOT (type='index' AND sql IS NULL AND substr(name,1,17)='sqlite_autoindex_') ORDER BY type,name",
    )
    .all();
  const tables = schema
    .filter((row) => row.type === "table")
    .map((row) => ({
      name: row.name,
      columns: db.prepare("PRAGMA table_xinfo(" + quote(row.name) + ")").all(),
      foreignKeys: db.prepare("PRAGMA foreign_key_list(" + quote(row.name) + ")").all(),
      indexes: db
        .prepare("PRAGMA index_list(" + quote(row.name) + ")")
        .all()
        .map((index) => ({ ...index, columns: db.prepare("PRAGMA index_xinfo(" + quote(index.name) + ")").all() })),
    }));
  if (!schema.some((row) => row.type === "table" && row.name === "migration")) nativeFail("NATIVE_OPENCODE_SCHEMA_UNQUALIFIED");
  return {
    schema,
    tables,
    migrationIds: db
      .prepare("SELECT id FROM migration ORDER BY id")
      .all()
      .map((row) => row.id),
    journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode,
    userVersion: db.prepare("PRAGMA user_version").get().user_version,
  };
}
function verifySchema(db) {
  if (!equal(schemaInventory(db), profile.database)) nativeFail("NATIVE_OPENCODE_SCHEMA_UNQUALIFIED");
}
function pinFile(file) {
  if (!path.isAbsolute(file)) nativeFail("NATIVE_OPENCODE_EXACT_DB_REQUIRED");
  const parent = pinNativeRoot(nativeRoot(path.dirname(file))),
    original = fs.lstatSync(file);
  const verify = () => {
    parent.verify();
    const current = fs.lstatSync(file);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      current.birthtimeMs !== original.birthtimeMs
    )
      nativeFail("NATIVE_OPENCODE_DATABASE_IDENTITY_CHANGED");
  };
  verify.identity = digest({ dev: original.dev, ino: original.ino, birthtimeMs: original.birthtimeMs });
  verify();
  return verify;
}
function openDatabase(file, writable) {
  const verify = pinFile(file);
  const db = new DatabaseSync(file, { readOnly: !writable, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
  try {
    db.exec("PRAGMA busy_timeout=0");
    verify();
    return { db, verify };
  } catch (error) {
    db.close();
    throw error;
  }
}
function targetProject(db, root, projectId) {
  const target = normalizedPath(root);
  const rows = db
    .prepare(
      "SELECT id,worktree FROM project WHERE (worktree=? OR EXISTS (SELECT 1 FROM project_directory d WHERE d.project_id=project.id AND d.directory=?))" +
        (projectId === undefined ? "" : " AND id=?"),
    )
    .all(...(projectId === undefined ? [target, target] : [target, target, projectId]));
  if (rows.length !== 1) nativeFail("NATIVE_OPENCODE_TARGET_PROJECT_UNQUALIFIED");
  return rows[0];
}

function toSessionRow(info) {
  const tokens = info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID ?? null,
    slug: info.slug,
    directory: info.directory,
    path: info.path ?? null,
    title: info.title,
    version: info.version,
    share_url: info.share?.url ?? null,
    summary_additions: info.summary?.additions ?? null,
    summary_deletions: info.summary?.deletions ?? null,
    summary_files: info.summary?.files ?? null,
    summary_diffs: json(info.summary?.diffs),
    metadata: json(info.metadata),
    cost: info.cost ?? 0,
    tokens_input: tokens.input,
    tokens_output: tokens.output,
    tokens_reasoning: tokens.reasoning,
    tokens_cache_read: tokens.cache.read,
    tokens_cache_write: tokens.cache.write,
    revert: json(info.revert),
    permission: json(info.permission),
    agent: info.agent ?? null,
    model: json(info.model),
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting ?? null,
    time_archived: info.time.archived ?? null,
  };
}
function fromSessionRow(row) {
  const hasSummary = [row.summary_additions, row.summary_deletions, row.summary_files].some((value) => value !== null);
  return clean({
    id: row.id,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    parentID: row.parent_id ?? undefined,
    slug: row.slug,
    directory: row.directory,
    path: row.path ?? undefined,
    title: row.title,
    version: row.version,
    agent: row.agent ?? undefined,
    model: parsed(row.model),
    summary: hasSummary
      ? { additions: row.summary_additions ?? 0, deletions: row.summary_deletions ?? 0, files: row.summary_files ?? 0, diffs: parsed(row.summary_diffs) }
      : undefined,
    metadata: parsed(row.metadata),
    share: row.share_url ? { url: row.share_url } : undefined,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
    },
    permission: parsed(row.permission),
    revert: parsed(row.revert),
    time: { created: row.time_created, updated: row.time_updated, compacting: row.time_compacting ?? undefined, archived: row.time_archived ?? undefined },
  });
}
function ordered(document) {
  const compareId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    info: document.info,
    messages: [...document.messages]
      .sort((a, b) => a.info.time.created - b.info.time.created || compareId(a.info.id, b.info.id))
      .map((row) => ({ info: row.info, parts: [...row.parts].sort((a, b) => compareId(a.id, b.id)) })),
  };
}
function prepare(documents, root, project) {
  if (!Array.isArray(documents) || !documents.length) nativeFail("NATIVE_OPENCODE_SELECTION_INVALID");
  const sessions = new Set(),
    messages = new Map(),
    parts = new Set();
  const plans = documents.map(({ nativeId, raw }) => {
    const document = decodeOpenCodeAtomicHistory(raw, nativeId);
    if (sessions.has(nativeId)) nativeFail("NATIVE_OPENCODE_GLOBAL_SESSION_COLLISION");
    sessions.add(nativeId);
    // Source active choices must have been removed by the existing derivation.
    if (
      ["permission", "model", "agent", "revert", "workspaceID"].some((key) => Object.hasOwn(document.info, key)) ||
      Object.hasOwn(document.info.time, "compacting")
    )
      nativeFail("NATIVE_OPENCODE_SOURCE_ACTIVE_SETTINGS_REJECTED");
    const info = {
      ...document.info,
      projectID: project.id,
      directory: normalizedPath(root),
      path: path.relative(path.resolve(project.worktree), root).replaceAll("\\", "/"),
    };
    const session = toSessionRow(info);
    for (const row of document.messages) {
      if (messages.has(row.info.id)) nativeFail("NATIVE_OPENCODE_GLOBAL_MESSAGE_COLLISION");
      messages.set(row.info.id, nativeId);
      for (const part of row.parts) {
        if (parts.has(part.id)) nativeFail("NATIVE_OPENCODE_GLOBAL_PART_COLLISION");
        parts.add(part.id);
      }
    }
    const normalizations = ["bind-current-target-project-directory-path"];
    if (document.info.cost === undefined) normalizations.push("official-missing-cost-zero");
    if (document.info.tokens === undefined) normalizations.push("official-missing-session-tokens-zero");
    if (document.info.share?.url === "") normalizations.push("official-empty-share-url-omitted");
    return { document, session, normalizations, expected: ordered({ info: fromSessionRow(session), messages: document.messages }) };
  });
  for (const plan of plans) {
    if (plan.document.info.parentID === plan.document.info.id) nativeFail("NATIVE_OPENCODE_PARENT_CYCLE");
    const visited = new Set([plan.document.info.id]);
    let parent = plan.document.info.parentID;
    while (parent && sessions.has(parent)) {
      if (visited.has(parent)) nativeFail("NATIVE_OPENCODE_PARENT_CYCLE");
      visited.add(parent);
      parent = plans.find((row) => row.document.info.id === parent).document.info.parentID;
    }
    for (const row of plan.document.messages)
      if (row.info.role === "assistant" && messages.has(row.info.parentID) && messages.get(row.info.parentID) !== plan.document.info.id)
        nativeFail("NATIVE_OPENCODE_MESSAGE_PARENT_OWNER_MISMATCH");
  }
  return plans;
}
function readDocument(db, nativeId) {
  const row = db.prepare("SELECT * FROM session WHERE id=?").get(nativeId);
  if (!row) return null;
  const messages = db
    .prepare("SELECT id,session_id,time_created,data FROM message WHERE session_id=? ORDER BY time_created,id")
    .all(nativeId)
    .map((message) => {
      const data = JSON.parse(message.data);
      if (data.time?.created !== message.time_created) nativeFail("NATIVE_OPENCODE_MESSAGE_ORDER_MISMATCH");
      const parts = db
        .prepare("SELECT id,message_id,session_id,data FROM part WHERE message_id=? ORDER BY id")
        .all(message.id)
        .map((part) => {
          if (part.session_id !== nativeId) nativeFail("NATIVE_OPENCODE_PART_OWNER_MISMATCH");
          return { ...JSON.parse(part.data), id: part.id, sessionID: part.session_id, messageID: part.message_id };
        });
      return { info: { ...data, id: message.id, sessionID: message.session_id }, parts };
    });
  return { info: fromSessionRow(row), messages };
}
function observe(db, plans) {
  let present = 0;
  const observed = [];
  for (const plan of plans) {
    const id = plan.document.info.id;
    let actual;
    try {
      actual = readDocument(db, id);
    } catch (error) {
      if (["NATIVE_OPENCODE_MESSAGE_ORDER_MISMATCH", "NATIVE_OPENCODE_PART_OWNER_MISMATCH"].includes(error.code))
        return { state: "diverged", primaryReadbackCode: error.code };
      throw error;
    }
    const expectedParts = new Map(plan.document.messages.flatMap((message) => message.parts.map((part) => [part.id, message.info.id])));
    if (
      db
        .prepare("SELECT id,message_id FROM part WHERE session_id=?")
        .all(id)
        .some((part) => expectedParts.get(part.id) !== part.message_id)
    )
      return { state: "diverged" };
    if (actual) {
      present++;
      if (!equal(actual, plan.expected)) return { state: "diverged" };
      observed.push(actual);
    }
    for (const message of plan.document.messages) {
      const owner = db.prepare("SELECT session_id FROM message WHERE id=?").get(message.info.id);
      if (owner && (!actual || owner.session_id !== id)) return { state: "diverged" };
      if (message.info.role === "assistant") {
        const parent = db.prepare("SELECT session_id FROM message WHERE id=?").get(message.info.parentID);
        if (parent && parent.session_id !== id) return { state: "diverged" };
      }
      for (const part of message.parts) {
        const owner = db.prepare("SELECT session_id,message_id FROM part WHERE id=?").get(part.id);
        if (owner && (!actual || owner.session_id !== id || owner.message_id !== message.info.id)) return { state: "diverged" };
      }
    }
  }
  if (present !== plans.length) return { state: present ? "partial" : "absent" };
  return { state: "matches", evidenceDigest: digest(observed), documents: observed };
}

function verifyParentAncestry(db, plans, projectId, check) {
  const selected = new Map(plans.map((plan) => [plan.document.info.id, plan.document.info.parentID]));
  const existing = db.prepare("SELECT id,project_id,parent_id FROM session WHERE id=?");
  for (const plan of plans) {
    const visited = new Set([plan.document.info.id]);
    let parent = plan.document.info.parentID;
    // Follow only the reachable exact-ID chain, each ID at most once. No
    // transcript/body scan, arbitrary depth gate or invented missing parent.
    while (parent) {
      check();
      if (visited.has(parent)) nativeFail("NATIVE_OPENCODE_PARENT_CYCLE");
      visited.add(parent);
      if (selected.has(parent)) {
        parent = selected.get(parent);
        continue;
      }
      const row = existing.get(parent);
      if (!row) break;
      if (row.project_id !== projectId) nativeFail("NATIVE_OPENCODE_SESSION_PARENT_OWNER_MISMATCH");
      parent = row.parent_id;
    }
  }
}

// Read-only preflight is also used for uncertain-outcome reconciliation. An
// exact existing batch is readable, never a license to execute it again.
export function inspectOpenCodeAtomicBatch({ databaseFile, root, projectId, documents, signal, assertCurrentAuthority = () => {} }) {
  nativeCheck(signal, assertCurrentAuthority);
  const rootPin = pinNativeRoot(nativeRoot(root));
  const { db, verify } = openDatabase(databaseFile, false);
  try {
    db.exec("BEGIN");
    verifySchema(db);
    const project = targetProject(db, root, projectId);
    const plans = prepare(documents, root, project);
    verifyParentAncestry(db, plans, project.id, () => {
      nativeCheck(signal, assertCurrentAuthority);
      rootPin.verify();
      verify();
    });
    const result = observe(db, plans);
    nativeCheck(signal, assertCurrentAuthority);
    rootPin.verify();
    verify();
    db.exec("ROLLBACK");
    return {
      ...result,
      projectId: project.id,
      profileId: profile.profileId,
      databaseIdentity: verify.identity,
      normalizations: plans.map((plan) => ({ nativeId: plan.document.info.id, operations: plan.normalizations })),
    };
  } finally {
    db.close();
  }
}

export async function publishOpenCodeAtomicBatch({
  databaseFile,
  root,
  projectId,
  documents,
  signal,
  assertCurrentAuthority = () => {},
  onPhase = async () => {},
}) {
  if (!Array.isArray(documents) || !documents.length) nativeFail("NATIVE_OPENCODE_SELECTION_INVALID");
  documents = documents.map(({ nativeId, raw }) => ({ nativeId, raw: Buffer.from(raw) }));
  const rootPin = pinNativeRoot(nativeRoot(root));
  const preflight = inspectOpenCodeAtomicBatch({ databaseFile, root, projectId, documents, signal, assertCurrentAuthority });
  if (preflight.state !== "absent") nativeFail("NATIVE_OPENCODE_BATCH_NOT_WRITE_ELIGIBLE");
  const { db, verify } = openDatabase(databaseFile, true);
  const check = () => {
    nativeCheck(signal, assertCurrentAuthority);
    rootPin.verify();
    verify();
    if (verify.identity !== preflight.databaseIdentity) nativeFail("NATIVE_OPENCODE_DATABASE_IDENTITY_CHANGED");
  };
  let begun = false,
    commitAttempted = false,
    committed = false;
  const phase = async (name, extra = {}) => {
    check();
    await onPhase({ phase: name, ...extra });
    await new Promise(setImmediate);
    check();
  };
  try {
    await phase("before-begin");
    db.exec("BEGIN IMMEDIATE");
    begun = true;
    verifySchema(db);
    const project = targetProject(db, root, preflight.projectId);
    const plans = prepare(documents, root, project);
    verifyParentAncestry(db, plans, project.id, check);
    if (observe(db, plans).state !== "absent") nativeFail("NATIVE_OPENCODE_BATCH_NOT_WRITE_ELIGIBLE");
    await phase("transaction-admitted");
    const importedAt = Date.now();
    const insert = (table, row) => {
      const keys = Object.keys(row);
      db.prepare("INSERT INTO " + quote(table) + " (" + keys.map(quote).join(",") + ") VALUES (" + keys.map(() => "?").join(",") + ")").run(
        ...keys.map((key) => row[key]),
      );
    };
    for (const plan of plans) {
      check();
      insert("session", plan.session);
      await phase("row-inserted", { kind: "session" });
      for (const row of plan.document.messages) {
        check();
        const { id, sessionID, ...data } = row.info;
        insert("message", { id, session_id: sessionID, time_created: row.info.time.created, time_updated: importedAt, data: json(data) });
        await phase("row-inserted", { kind: "message" });
        for (const part of row.parts) {
          check();
          const { id, sessionID, messageID, ...data } = part;
          insert("part", { id, session_id: sessionID, message_id: messageID, time_created: importedAt, time_updated: importedAt, data: json(data) });
          await phase("row-inserted", { kind: "part" });
        }
      }
    }
    const inside = observe(db, plans);
    if (inside.state !== "matches") nativeFail("NATIVE_OPENCODE_TRANSACTION_READBACK_MISMATCH");
    await phase("before-commit");
    verifySchema(db);
    targetProject(db, root, project.id);
    check();
    commitAttempted = true;
    db.exec("COMMIT");
    begun = false;
    committed = true;
    await phase("after-commit");
    return {
      state: "matches",
      evidenceDigest: inside.evidenceDigest,
      batchCommitted: true,
      sessions: plans.length,
      messages: plans.reduce((n, plan) => n + plan.document.messages.length, 0),
      parts: plans.reduce((n, plan) => n + plan.document.messages.reduce((count, row) => count + row.parts.length, 0), 0),
      profileId: profile.profileId,
      recoveryAuthorityCreated: false,
    };
  } catch (error) {
    let rolledBack = false;
    if (begun) {
      try {
        db.exec("ROLLBACK");
        rolledBack = true;
      } catch {}
    }
    error.nativeDatabaseOutcome =
      committed || commitAttempted ? "commit-outcome-requires-exact-readback" : rolledBack ? "logical-transaction-rolled-back" : "no-transaction-committed";
    if (String(error.code).includes("BUSY") || /database is locked/iu.test(error.message)) error.code = "NATIVE_OPENCODE_WRITER_BUSY";
    throw error;
  } finally {
    db.close();
  }
}

export function readOpenCodeAtomicHistory({ databaseFile, root, projectId, nativeId, signal, assertCurrentAuthority = () => {} }) {
  nativeCheck(signal, assertCurrentAuthority);
  const { db, verify } = openDatabase(databaseFile, false);
  try {
    db.exec("BEGIN");
    verifySchema(db);
    const project = targetProject(db, root, projectId),
      document = readDocument(db, nativeId);
    if (!document || document.info.projectID !== project.id || document.info.directory !== normalizedPath(root))
      nativeFail("NATIVE_OPENCODE_TARGET_PROJECT_MISMATCH");
    nativeCheck(signal, assertCurrentAuthority);
    verify();
    db.exec("ROLLBACK");
    return document;
  } finally {
    db.close();
  }
}
export function listOpenCodeAtomicHistory({ databaseFile, root, projectId, signal, assertCurrentAuthority = () => {} }) {
  nativeCheck(signal, assertCurrentAuthority);
  const { db, verify } = openDatabase(databaseFile, false);
  try {
    db.exec("BEGIN");
    verifySchema(db);
    const project = targetProject(db, root, projectId);
    const rows = db
      .prepare(
        "SELECT id,title,time_created,time_updated FROM session WHERE project_id=? AND directory=? AND parent_id IS NULL ORDER BY time_updated DESC,id DESC",
      )
      .all(project.id, normalizedPath(root));
    nativeCheck(signal, assertCurrentAuthority);
    verify();
    db.exec("ROLLBACK");
    return rows;
  } finally {
    db.close();
  }
}

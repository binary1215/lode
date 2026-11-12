#!/usr/bin/env node
// Prints Lode surface metrics measured from this tree:
//
//   node scripts/audit-metrics.mjs          # table
//   node scripts/audit-metrics.mjs --json   # JSON
//
// It only prints. There are no limits and no exit code for any value: a
// failing check above a limit is ruled out by design (docs/rule-surface-audit.md).
// The save and resume call counts run the in-process MCP server on temporary
// projects under os.tmpdir(); nothing is written into the repository, and the
// temporary directories are removed before exit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { measureContextDiagnostics } from "./measure-context-diagnostics.mjs";
import { catalogTools, operationCatalogTools, toolsForSurface } from "./mcp-server.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posix = (file) => path.relative(pluginRoot, file).replaceAll("\\", "/");

// The phrase list of the 0.3.0-beta.109/110 measurements (CHANGELOG): whole
// words, case-insensitive. "Must", "forbidden" and similar words are not counted.
export const PROHIBITION_PHRASES = ["never", "do not", "must not", "cannot"];
const prohibitionPattern = new RegExp(`\\b(?:${PROHIBITION_PHRASES.map((phrase) => phrase.replace(" ", "\\s+")).join("|")})\\b`, "gi");

export function countProhibitions(text) {
  const byPhrase = Object.fromEntries(PROHIBITION_PHRASES.map((phrase) => [phrase, 0]));
  for (const [match] of text.matchAll(prohibitionPattern)) byPhrase[match.toLowerCase().replace(/\s+/g, " ")] += 1;
  return { total: Object.values(byPhrase).reduce((sum, count) => sum + count, 0), byPhrase };
}

// The four Skill references rewritten in 0.3.0-beta.110 (design step 4-C).
const REFERENCE_SET_4C = ["conversation-ux.md", "recovery-workflow.md", "runtime-composition.md", "project-discovery.md"];

// Delegation is not scripted: a model-worker run needs a provider. These are hand
// counts of the documented paths (sources named per entry).
const DELEGATION_HAND_COUNTS = [
  {
    path: "ordinary Host delegation (default)",
    lodeCalls: 0,
    hostCalls: "1 per worker (the Host's own subagent or fork tool)",
    source: "skills/lode-agent-core/references/runtime-composition.md#choose-execution-means-separately-from-risk",
  },
  {
    path: "managed worker, launch to frozen patch",
    lodeCalls: 4,
    hostCalls: "0",
    calls: [
      "lode_bounded_worker (prepare)",
      "lode_bounded_worker (start)",
      "lode_bounded_worker_job_status (1 or more until terminal)",
      "lode_bounded_worker_job (patch)",
    ],
    note: "Minimum. Each managed or routed call goes through lode_tools_call or lode_tools_read; discovery is skipped for known tools.",
    source: "docs/worker-context-integration.md (sections 2 and 3)",
  },
  {
    path: "managed worker, frozen patch to integrated Run result",
    lodeCalls: 4,
    hostCalls: "0",
    calls: [
      "lode_worker_integration (prepare)",
      "lode_worker_integration (apply)",
      "lode_worker_integration (prepare-result)",
      "lode_worker_integration (publish-result)",
    ],
    note: "Run-only; opening the Run and the later review are not counted.",
    source: "docs/worker-context-integration.md#3-combine-and-apply-changes-through-one-lode-flow",
  },
];

function frontmatterDescription(file) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = match?.[1].split(/\r?\n/).find((entry) => entry.startsWith("description:"));
  return line ? line.slice("description:".length).trim() : "";
}

function skillFiles() {
  const skills = path.join(pluginRoot, "skills");
  return fs
    .readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skills, entry.name, "SKILL.md")))
    .map((entry) => path.join(skills, entry.name, "SKILL.md"))
    .sort();
}

function referenceFiles() {
  const files = [];
  for (const skill of skillFiles()) {
    const directory = path.join(path.dirname(skill), "references");
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).sort()) if (name.endsWith(".md")) files.push(path.join(directory, name));
  }
  return files;
}

function textEntry(fields, text) {
  return { ...fields, chars: text.length, utf8Bytes: Buffer.byteLength(text, "utf8"), prohibitions: countProhibitions(text).total };
}

// Host-local state goes to one temporary root, never the user's home.
async function withTemporaryState(operation) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lode-audit-metrics-"));
  const hostRoot = path.join(temporary, "host-state");
  fs.mkdirSync(hostRoot);
  const saved = Object.fromEntries(["HEAD_AGENT_OPERATIONAL_STATE_ROOT", "LODE_AGENT_OPERATIONAL_STATE_ROOT"].map((name) => [name, process.env[name]]));
  for (const name of Object.keys(saved)) process.env[name] = hostRoot;
  const project = (label) => {
    const root = path.join(temporary, label);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "login.mjs"), "export function login(user) {\n  return Boolean(user);\n}\n");
    return root;
  };
  try {
    return await operation({ project, hostRoot });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const recovery = {
  purpose: "Fix the login failure",
  approved_decisions: ["Keep the existing login contract"],
  current_position: "Cause identified; fix pending",
  next_expected_result: "Login regression test passes",
};

async function measureFlows({ project, hostRoot }) {
  const { dispatch } = await import("./mcp-server.mjs");
  const { createNativeSessionHostBridge } = await import("./lib/session/session-native-host.mjs");
  const { sessionStartContext } = await import("./session-host-hook.mjs");
  const call = async (root, name, args = {}, options = {}, meta = undefined) => {
    const response = await dispatch(
      { jsonrpc: "2.0", id: name, method: "tools/call", params: { ...(meta ? { _meta: meta } : {}), name, arguments: { project_root: root, ...args } } },
      options,
    );
    if (response.error) throw Object.assign(new Error(`${name}: ${response.error.message}`), { code: response.error.data?.reasonCode });
    return response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
  };
  const initialize = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const toolsList = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  // Unverified MCP caller (and the CLI): read the basis, then sync.
  const plain = project("plain");
  // This project opts in to root instruction files, so CLAUDE.md and AGENTS.md exist.
  await call(plain, "lode_project_initialize_or_resume", { profile: "core", write_root_instruction_files: true });
  const generated = {};
  for (const relative of [".lode/generated/lode-instructions.md", "CLAUDE.md", "AGENTS.md"]) {
    const file = path.join(plain, relative);
    if (fs.existsSync(file)) generated[relative] = fs.readFileSync(file, "utf8");
  }
  await call(plain, "lode_conversation_enter");
  const basis = await call(plain, "lode_checkpoint_basis");
  const plainSave = await call(plain, "lode_checkpoint_sync", { expected_recovery_basis_id: basis.basis.basisId, ...recovery });

  // Resume in a new conversation: one read-only entry call returns the saved direction.
  const resumed = await call(plain, "lode_conversation_enter");
  const resumedText = JSON.stringify(resumed);

  // SessionStart Hook (Claude Code and Codex): context arrives before the first model turn.
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: hostRoot };
  const fresh = project("fresh");
  // Default initialization: what a project gets without opting in.
  const freshInit = await call(fresh, "lode_project_initialize_or_resume", { profile: "core" });
  const rootInstructionsByDefault = {
    claude: freshInit.project?.integrations?.claude?.instruction?.status ?? "unknown",
    codex: freshInit.project?.integrations?.codex?.status ?? "unknown",
    opencode: freshInit.project?.integrations?.opencode?.status ?? "unknown",
  };
  const startFresh = await sessionStartContext({
    runtime: "claude",
    event: { hook_event_name: "SessionStart", source: "startup", cwd: fresh, session_id: "audit-metrics-fresh" },
    environment,
  });
  // A Host conversation that is not linked to a Session yet gets orientation only.
  const startUnlinked = await sessionStartContext({
    runtime: "claude",
    event: { hook_event_name: "SessionStart", source: "startup", cwd: plain, session_id: "audit-metrics-unlinked" },
    environment,
  });
  const hookFresh = startFresh.hookSpecificOutput?.additionalContext ?? "";
  const hookUnlinked = JSON.parse(startUnlinked.hookSpecificOutput?.additionalContext ?? "{}");

  // Verified Host caller (Codex thread route): entry, then one sync with no basis id.
  const verified = project("verified");
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  let verifiedSave;
  try {
    const options = { nativeSessionBridge: bridge };
    const meta = { threadId: "audit-metrics" };
    await call(verified, "lode_project_initialize_or_resume", { profile: "core" }, options, meta);
    await call(verified, "lode_conversation_enter", {}, options, meta);
    verifiedSave = await call(verified, "lode_checkpoint_sync", recovery, options, meta);
  } finally {
    bridge.dispose();
  }
  // The same Codex thread starts again after compaction: the Hook delivers the saved direction.
  const startLinked = await sessionStartContext({
    runtime: "codex",
    event: { hook_event_name: "SessionStart", source: "compact", cwd: verified, session_id: "audit-metrics" },
    environment,
  });
  const hookLinkedText = startLinked.hookSpecificOutput?.additionalContext ?? "{}";

  return {
    instructions: initialize.result.instructions,
    toolsListResult: toolsList.result,
    generated,
    rootInstructionsByDefault,
    hookFresh,
    hookLinkedChars: hookLinkedText.length,
    flows: {
      save: [
        { caller: "unverified MCP caller or CLI", calls: 2, sequence: ["lode_checkpoint_basis", "lode_checkpoint_sync"], outcome: plainSave.outcome },
        { caller: "verified Host caller after entry", calls: 1, sequence: ["lode_checkpoint_sync"], outcome: verifiedSave.outcome },
      ],
      resume: [
        {
          caller: "new conversation, any MCP caller",
          calls: 1,
          sequence: ["lode_conversation_enter"],
          status: resumed.status,
          savedPurposeReturned: resumedText.includes(recovery.purpose),
        },
        {
          caller: "same Host conversation after compaction, SessionStart Hook (Codex)",
          calls: 0,
          sequence: [],
          status: JSON.parse(hookLinkedText).status,
          savedPurposeReturned: hookLinkedText.includes(recovery.purpose),
        },
        {
          caller: "new Host conversation not linked yet, SessionStart Hook (Claude Code)",
          calls: 1,
          sequence: ["lode_conversation_enter"],
          status: `Hook gives ${hookUnlinked.status}; entry gives ${resumed.status}`,
          savedPurposeReturned: resumedText.includes(recovery.purpose),
        },
      ],
      delegation: DELEGATION_HAND_COUNTS,
    },
  };
}

export async function auditMetrics() {
  const diagnostics = await measureContextDiagnostics();
  const measured = await withTemporaryState(measureFlows);
  const entry = measured.instructions;

  const alwaysRead = [
    textEntry({ id: "mcp-instructions", source: "scripts/lib/session/lode-entry-guidance.mjs", delivery: "MCP initialize `instructions`" }, entry),
    textEntry(
      {
        id: "project-instructions",
        optIn: true,
        source: ".lode/generated/lode-instructions.md (temporary core project)",
        delivery: "root CLAUDE.md / AGENTS.md / opencode.json only when written (opt-in)",
        rootInstructionsByDefault: measured.rootInstructionsByDefault,
        managedFilesEqual: ["CLAUDE.md", "AGENTS.md"].filter((name) => measured.generated[name] === measured.generated[".lode/generated/lode-instructions.md"]),
      },
      measured.generated[".lode/generated/lode-instructions.md"] ?? "",
    ),
    textEntry(
      {
        id: "session-start-context",
        source: "scripts/session-host-hook.mjs (fresh core project, Claude startup)",
        delivery: "SessionStart `additionalContext`",
      },
      measured.hookFresh,
    ),
    ...skillFiles().map((file) =>
      textEntry(
        { id: `skill-description:${path.basename(path.dirname(file))}`, source: posix(file), delivery: "Skill list (frontmatter `description`)" },
        frontmatterDescription(file),
      ),
    ),
  ];
  const texts = {
    "project-instructions": measured.generated[".lode/generated/lode-instructions.md"] ?? "",
    "session-start-context": measured.hookFresh,
  };
  const summarize = (items) => {
    const chars = items.reduce((total, item) => total + item.chars, 0);
    const repeats = items.filter((item) => texts[item.id]?.includes(entry)).map((item) => item.id);
    return { chars, entryParagraphRepeatedIn: repeats, charsEntryParagraphOnce: chars - repeats.length * entry.length };
  };

  const progressive = [...skillFiles(), ...referenceFiles()].map((file) => {
    const text = fs.readFileSync(file, "utf8");
    return { file: posix(file), chars: text.length, ...countProhibitions(text) };
  });
  const set4c = progressive.filter((item) => REFERENCE_SET_4C.includes(path.basename(item.file)));

  const defaultTools = measured.toolsListResult.tools;
  const listJson = JSON.stringify(measured.toolsListResult);
  return {
    schemaVersion: 1,
    kind: "LodeAuditMetrics",
    sourceRevision: diagnostics.sourceRevision,
    limits: "none (print only)",
    alwaysRead: {
      sources: alwaysRead,
      entryParagraphChars: entry.length,
      byDefault: summarize(alwaysRead.filter((item) => !item.optIn)),
      withRootInstructionFiles: summarize(alwaysRead),
      sessionStartContextAfterOneSaveChars: measured.hookLinkedChars,
    },
    prohibitions: {
      phrases: PROHIBITION_PHRASES,
      method: "whole-word, case-insensitive regular expression over the full text",
      alwaysReadByDefault: alwaysRead.filter((item) => !item.optIn).reduce((total, item) => total + item.prohibitions, 0),
      alwaysReadWithRootInstructionFiles: alwaysRead.reduce((total, item) => total + item.prohibitions, 0),
      files: progressive,
      referenceSet4C: { files: set4c.map((item) => item.file), chars: set4c.reduce((t, i) => t + i.chars, 0), total: set4c.reduce((t, i) => t + i.total, 0) },
    },
    tools: {
      defaultToolsList: defaultTools.length,
      defaultToolNames: defaultTools.map((tool) => tool.name),
      managedMaintenanceToolsList: toolsForSurface("managed-maintenance").length,
      listedCatalog: catalogTools.length,
      operationCatalogWithDeprecatedNames: operationCatalogTools.length,
      toolsListResultChars: listJson.length,
      toolsListResultUtf8Bytes: Buffer.byteLength(listJson, "utf8"),
      catalogArrayUtf8Bytes: diagnostics.mcpCatalog.catalogArrayUtf8Bytes,
    },
    calls: {
      method: "save and resume: scripted on temporary core projects with the in-process MCP server; delegation: hand count of the documented paths",
      ...measured.flows,
    },
  };
}

function table(report) {
  const rows = [];
  const add = (metric, value, note = "") => rows.push([metric, String(value), note]);
  for (const item of report.alwaysRead.sources) add(`always-read chars: ${item.id}`, item.chars, item.delivery);
  const { byDefault, withRootInstructionFiles } = report.alwaysRead;
  add("always-read chars: sum by default", byDefault.chars, "without the opt-in root instruction files");
  add(
    "always-read chars: sum by default, entry paragraph once",
    byDefault.charsEntryParagraphOnce,
    `entry paragraph ${report.alwaysRead.entryParagraphChars} chars`,
  );
  add("always-read chars: sum with root instruction files", withRootInstructionFiles.chars);
  add("always-read chars: sum with root files, entry paragraph once", withRootInstructionFiles.charsEntryParagraphOnce);
  add("session-start-context after one save", report.alwaysRead.sessionStartContextAfterOneSaveChars, "chars; grows with saved direction (not summed)");
  add("prohibitions: always-read by default", report.prohibitions.alwaysReadByDefault, report.prohibitions.phrases.join(" | "));
  add("prohibitions: always-read with root files", report.prohibitions.alwaysReadWithRootInstructionFiles);
  for (const item of report.prohibitions.files) add(`prohibitions: ${item.file}`, item.total, `${item.chars} chars`);
  add("prohibitions: 4-C reference set", report.prohibitions.referenceSet4C.total, `${report.prohibitions.referenceSet4C.chars} chars`);
  add("tools: default tools/list", report.tools.defaultToolsList);
  add("tools: managed-maintenance tools/list", report.tools.managedMaintenanceToolsList);
  add("tools: listed catalog (discovery)", report.tools.listedCatalog);
  add("tools: all operations incl. deprecated names", report.tools.operationCatalogWithDeprecatedNames);
  add("tools/list result size", `${report.tools.toolsListResultChars} chars / ${report.tools.toolsListResultUtf8Bytes} bytes`, "default surface, JSON");
  for (const item of report.calls.save) add(`calls: save (${item.caller})`, item.calls, `${item.sequence.join(" -> ")}; outcome ${item.outcome}`);
  for (const item of report.calls.resume)
    add(
      `calls: resume (${item.caller})`,
      item.calls,
      `${item.sequence.join(" -> ") || "none"}; ${item.status}; saved purpose returned: ${item.savedPurposeReturned}`,
    );
  for (const item of report.calls.delegation) add(`calls: delegation (${item.path})`, item.lodeCalls, `hand count; Host calls: ${item.hostCalls}`);
  const width = [0, 1].map((column) => Math.max(...rows.map((row) => row[column].length)));
  const revision = report.sourceRevision.commit ? report.sourceRevision.commit.slice(0, 12) : report.sourceRevision.status;
  return [
    `Lode audit metrics (commit ${revision}; print only, no limits)`,
    ...rows.map(([metric, value, note]) => `${metric.padEnd(width[0])}  ${value.padStart(width[1])}  ${note}`),
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--json")) {
    process.stdout.write("Usage: node scripts/audit-metrics.mjs [--json]\nPrints measured values only. No limits, no failing exit code for a value.\n");
  } else {
    const report = await auditMetrics();
    process.stdout.write(`${args.includes("--json") ? JSON.stringify(report, null, 2) : table(report)}\n`);
  }
}

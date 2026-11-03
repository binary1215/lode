import fs from "node:fs";
import path from "node:path";

// Codex records hook trust in the user's config, not in the project. This
// reader only reports that record. It does not write config or trust a hook.
const GUIDANCE = [
  "Codex does not run Lode hooks until you trust this exact hook definition.",
  "After install or init, open /hooks in the Codex CLI and trust the Lode plugin hooks.",
  "In the Codex desktop app, choose Review hooks in the composer, or open Settings > Hooks.",
  "Trust the project too, or Codex skips project-local .codex layers. Accept the prompt when Codex opens the folder, or set trust_level = \"trusted\" under [projects.\"<absolute project path>\"] in the Codex user config.",
  "Installing the plugin does not trust its hooks. A changed hook script asks for review again.",
  "codex exec skips untrusted hooks unless that invocation passes --dangerously-bypass-hook-trust. Prefer /hooks.",
].join(" ");

export function codexHookTrustGuidance() { return GUIDANCE; }

// Bounded TOML subset: quoted/dotted table keys, boolean/string assignments.
// Unsupported syntax is unknown, never evidence that a hook was trusted.
function uncomment(line) {
  let quote = null, escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && ch === "\\") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}
function stringValue(value) {
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return JSON.parse(value);
  throw new Error("Unsupported TOML string");
}
function tables(text) {
  const rows = []; let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = uncomment(raw).trim();
    if (!line) continue;
    if (line.includes('"""') || line.includes("'''")) throw new Error("Multiline TOML unverified");
    if (line.startsWith("[")) {
      if (!line.endsWith("]") || line.startsWith("[[")) { current = null; continue; }
      const body = line.slice(1, -1), keys = []; let rest = body;
      while (rest.trim()) {
        const m = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(\.|$)/.exec(rest);
        if (!m) throw new Error("Unsupported TOML key");
        keys.push(/["']/.test(m[1][0]) ? stringValue(m[1]) : m[1]); rest = rest.slice(m[0].length);
      }
      current = { keys, values: {} }; rows.push(current); continue;
    }
    if (!current) continue;
    if (!(current.keys[0] === "features" || current.keys[0] === "projects" || current.keys[0] === "hooks" && current.keys[1] === "state")) continue;
    const m = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || Object.hasOwn(current.values, m[1])) throw new Error("Unsupported/duplicate TOML assignment");
    current.values[m[1]] = m[2] === "true" ? true : m[2] === "false" ? false : stringValue(m[2]);
  }
  const keys = rows.map(row => JSON.stringify(row.keys));
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate TOML tables");
  return rows;
}
function projectTrustLevel(rows, root) {
  if (!root) return null;
  let resolved; try { resolved = fs.realpathSync(root); } catch { resolved = path.resolve(root); }
  return rows.find(row => row.keys.length === 2 && row.keys[0] === "projects" && [root, resolved].includes(row.keys[1]))?.values.trust_level ?? null;
}
function exactHookEntry(rows, hooksFile) {
  const names = new Set([hooksFile, hooksFile.replaceAll("\\", "/"), hooksFile.replaceAll("/", "\\")]);
  return rows.some(row => {
    if (row.keys.length !== 3 || row.keys[0] !== "hooks" || row.keys[1] !== "state") return false;
    const m = /^(.*):(SessionStart|UserPromptSubmit|PreToolUse|PermissionRequest|PostToolUse|PostToolUseFailure|Stop|SubagentStart|SubagentStop|PreCompact|PostCompact|SessionEnd):([0-9]+):([0-9]+)$/.exec(row.keys[2]);
    return m && names.has(m[1]) && typeof row.values.trusted_hash === "string" && row.values.trusted_hash.length > 0 && row.values.enabled !== false;
  });
}

export function inspectCodexHookTrust({ projectRoot = null, pluginRoot, environment = process.env, readFile = fs.readFileSync } = {}) {
  const home = typeof environment?.CODEX_HOME === "string" && path.isAbsolute(environment.CODEX_HOME)
    ? environment.CODEX_HOME
    : (typeof (environment?.HOME || environment?.USERPROFILE) === "string" && path.isAbsolute(environment.HOME || environment.USERPROFILE)
      ? path.join(environment.HOME || environment.USERPROFILE, ".codex") : null);
  const hooksFile = path.join(pluginRoot, "hooks", "codex.json");
  const base = { guidance: GUIDANCE, hooksFile, configPath: home ? path.join(home, "config.toml") : null, ordinaryWorkBlocked: false };
  if (!home) return { ...base, status: "unknown", reason: "codex-home-unavailable" };
  let text = "";
  try {
    const stat = fs.lstatSync(base.configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return { ...base, status: "unknown", reason: "codex-config-unreadable" };
    text = readFile(base.configPath, "utf8");
    if (typeof text !== "string" || text.includes("\0") || text.length > 1024 * 1024) return { ...base, status: "unknown", reason: "codex-config-unreadable" };
  } catch (error) {
    if (error.code === "ENOENT") return { ...base, status: "review-required", reason: "codex-config-absent", projectTrust: "not-recorded" };
    return { ...base, status: "unknown", reason: "codex-config-unreadable" };
  }
  let rows;
  try { rows = tables(text); } catch { return { ...base, status: "unknown", reason: "codex-config-format-unverified" }; }
  const features = rows.find(row => row.keys.length === 1 && row.keys[0] === "features")?.values || {};
  if (features.hooks === false || features.plugin_hooks === false) {
    return { ...base, status: "disabled", reason: "codex-hooks-disabled", projectTrust: projectTrustLevel(rows, projectRoot) || "not-recorded" };
  }
  const projectTrust = projectTrustLevel(rows, projectRoot) || "not-recorded";
  const recorded = exactHookEntry(rows, hooksFile);
  if (!recorded) return { ...base, status: rows.some(row => row.keys[0] === "hooks" && row.keys[1] === "state") ? "unknown" : "review-required", reason: "exact-hook-trust-unverified", projectTrust };
  return {
    ...base,
    status: "recorded",
    reason: "hook-trust-record-present",
    projectTrust,
    guidance: "The same exact hook-file state entry contains a trusted_hash. If Codex says the hook changed, open /hooks and trust the current definition. This record does not prove the running app loaded the hook.",
  };
}

export function formatCodexHookTrust(report) {
  if (!report) return null;
  const headline = {
    recorded: "Codex hook trust: a trust record names the installed Lode hook file.",
    "review-required": "Codex hook trust: not recorded. Lode hooks will not run until you review them.",
    disabled: "Codex hook trust: hooks or plugin hooks are disabled in the Codex user config.",
    "project-untrusted": "Codex hook trust: this project is marked untrusted, so its project hooks do not load.",
    unknown: "Codex hook trust: the exact installed hook trust is unverified.",
  }[report.status] || "Codex hook trust: not confirmed.";
  return `${headline} ${report.guidance}`;
}

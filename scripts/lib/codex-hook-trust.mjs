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

function sectionBody(text, header) {
  const match = text.match(new RegExp(`(?:^|\\n)\\[${header}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n\\[|$)`));
  return match ? match[1] : "";
}

function assignment(body, key) {
  const match = body.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*("?)([^"\\n#]+)\\1`));
  return match ? match[2].trim() : null;
}

function projectTrustLevel(text, projectRoot) {
  if (typeof projectRoot !== "string" || !projectRoot) return null;
  let resolved = projectRoot;
  try { resolved = fs.realpathSync(projectRoot); } catch { resolved = path.resolve(projectRoot); }
  const pattern = /(?:^|\n)\[projects\.(?:"([^"]+)"|'([^']+)'|([^\s\]]+))\][^\n]*\n([\s\S]*?)(?=\n\[|$)/g;
  for (const match of text.matchAll(pattern)) {
    const key = (match[1] || match[2] || match[3] || "").replaceAll("\\\\", "\\");
    if (key !== resolved && key !== projectRoot) continue;
    const level = assignment(match[4], "trust_level");
    if (level === "trusted" || level === "untrusted") return level;
  }
  return null;
}

function mentionsHookFile(text, hooksFile) {
  const names = new Set([hooksFile, hooksFile.replaceAll("\\", "/"), hooksFile.replaceAll("/", "\\")]);
  for (const name of names) if (text.includes(name)) return true;
  return text.includes("hooks/codex.json") && /trusted_hash\s*=/.test(text) && text.includes("session-host-hook");
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
  const features = sectionBody(text, "features");
  if (assignment(features, "hooks") === "false" || assignment(features, "plugin_hooks") === "false") {
    return { ...base, status: "disabled", reason: "codex-hooks-disabled", projectTrust: projectTrustLevel(text, projectRoot) || "not-recorded" };
  }
  const projectTrust = projectTrustLevel(text, projectRoot) || "not-recorded";
  if (projectTrust === "untrusted") return { ...base, status: "project-untrusted", reason: "codex-project-untrusted", projectTrust };
  const recorded = mentionsHookFile(text, hooksFile) && /trusted_hash\s*=/.test(text);
  if (!recorded) return { ...base, status: "review-required", reason: "hook-trust-not-recorded", projectTrust };
  return {
    ...base,
    status: "recorded",
    reason: "hook-trust-record-present",
    projectTrust,
    guidance: "A Codex config entry names this plugin hook file and a trusted_hash. If Codex says the hook changed, open /hooks and trust the current definition. This record does not prove the running app loaded the hook.",
  };
}

export function formatCodexHookTrust(report) {
  if (!report) return null;
  const headline = {
    recorded: "Codex hook trust: a trust record names the installed Lode hook file.",
    "review-required": "Codex hook trust: not recorded. Lode hooks will not run until you review them.",
    disabled: "Codex hook trust: hooks or plugin hooks are disabled in the Codex user config.",
    "project-untrusted": "Codex hook trust: this project is marked untrusted, so its project hooks do not load.",
    unknown: "Codex hook trust: the Codex user config could not be read.",
  }[report.status] || "Codex hook trust: not confirmed.";
  return `${headline} ${report.guidance}`;
}

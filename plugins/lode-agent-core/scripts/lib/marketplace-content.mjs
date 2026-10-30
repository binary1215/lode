import fs from "node:fs";
import path from "node:path";

const EXECUTABLE_EXTENSIONS = new Set([".js", ".mjs", ".ps1", ".py", ".sh", ".go"]);
const PROJECT_ID = /^(?:head|lode)-[a-f0-9]{20}$/;
const SESSION_ID = /^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function fail(file, reason) {
  const error = new Error(`Marketplace artifact contains ${reason}: ${file}`);
  error.code = "LODE_MARKETPLACE_CONTENT_CONTAMINATION";
  throw error;
}

function hasConcreteHomePath(text) {
  // This checks deployable configuration/code, not prose examples or generic
  // absolute paths. Explicit user templates remain portable configuration.
  const homes = /(?:^|[\s"'`(\[{=,:;])(?:file:\/\/)?(?:[a-z]:[\\/]+Users[\\/]+|\/(?:Users|home)\/)([^\s\\/"'<>`{}\[\]():;]+)[\\/]+/gi;
  for (const [, owner] of text.matchAll(homes)) {
    if (!/^(?:%[^%]+%|\$[A-Za-z_][A-Za-z0-9_]*)$/.test(owner)) return true;
  }
  return false;
}

function hasRuntimeRecord(value) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (!Array.isArray(current) && current.schemaVersion === 1) {
      const project = typeof current.projectId === "string" && PROJECT_ID.test(current.projectId)
        && typeof current.projectRoot === "string"
        && (path.posix.isAbsolute(current.projectRoot) || path.win32.isAbsolute(current.projectRoot))
        && typeof current.createdAt === "string" && Array.isArray(current.runtimes)
        && current.integrations && typeof current.integrations === "object";
      const session = typeof current.sessionId === "string" && SESSION_ID.test(current.sessionId) && current.mode === "session"
        && Object.hasOwn(current, "currentWholePlanId") && Object.hasOwn(current, "activeRunId")
        && Object.hasOwn(current, "latestCheckpoint") && typeof current.updatedAt === "string";
      if (project || session) return true;
    }
    for (const child of Object.values(current)) pending.push(child);
  }
  return false;
}

// Complements the caller's exact inventory/hash verification. Only verified
// package files are read; no host state, runtime authority, or mutation is used.
export function verifyMarketplaceContent({ root, files }) {
  for (const file of files) {
    const relative = file.replaceAll("\\", "/");
    const extension = path.posix.extname(relative).toLowerCase();
    if (extension !== ".json" && !EXECUTABLE_EXTENSIONS.has(extension)) continue;
    const text = fs.readFileSync(path.join(root, ...relative.split("/")), "utf8");
    if (hasConcreteHomePath(text)) fail(relative, "a concrete personal home path in executable configuration");
    if (extension === ".json") {
      let value;
      try { value = JSON.parse(text); } catch { continue; }
      // Standalone canonical-shaped records are not schema definitions or the
      // illustrative fenced JSON in documentation, which is intentionally read as prose.
      if (hasRuntimeRecord(value)) fail(relative, "a concrete Project or Session runtime record");
    }
  }
}

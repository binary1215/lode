import crypto from "node:crypto";
import fs from "node:fs";
import { atomicCreateArtifact, atomicWriteArtifact } from "./artifact-storage.mjs";
import { copiedProjectFile, inspectCopiedProjectFile, validateCopiedManagedPaths } from "./project-copy-evidence.mjs";
import { withLocalMutation } from "./project-mutation-lock.mjs";

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// Byte transformations only: no UTF-8 decoder, BOM removal, JSON serialization,
// path rewriting or replacement-character normalization of the source.
function lineEndingVariants(bytes) {
  const lf = Buffer.alloc(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) continue;
    lf[length++] = bytes[i];
  }
  const plain = lf.subarray(0, length);
  let extra = 0;
  for (let i = 0; i < plain.length; i++) if (plain[i] === 10 && plain[i - 1] !== 13) extra++;
  const crlf = Buffer.alloc(plain.length + extra);
  let at = 0;
  for (let i = 0; i < plain.length; i++) {
    if (plain[i] === 10 && plain[i - 1] !== 13) crlf[at++] = 13;
    crlf[at++] = plain[i];
  }
  return [plain, crlf];
}

export function inspectManagedByteRepairs({ root, directory, manifest } = {}) {
  if (![".head", ".lode"].includes(directory) || manifest?.schemaVersion !== 1 || !Array.isArray(manifest.managed)) fail("PROJECT_REPAIR_MANIFEST_INVALID");
  validateCopiedManagedPaths({ root, directory, manifest });
  const repairs = [],
    unresolved = [],
    seen = new Set();
  for (const entry of manifest.managed) {
    if (!entry || typeof entry.path !== "string" || seen.has(entry.path) || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256))
      fail("PROJECT_REPAIR_MANIFEST_INVALID");
    seen.add(entry.path);
    if (!entry.path.startsWith(`${directory}/`) && !["AGENTS.md", "CLAUDE.md", ".mcp.json", "opencode.json"].includes(entry.path))
      fail("PROJECT_REPAIR_MANIFEST_INVALID");
    let observed;
    try {
      observed = inspectCopiedProjectFile(root, entry.path);
    } catch (error) {
      if (error.code === "ENOENT") {
        unresolved.push({ path: entry.path, reasonCode: "MANAGED_FILE_MISSING" });
        continue;
      }
      throw error;
    }
    if (observed.sha256 === entry.sha256) continue;
    const before = fs.readFileSync(copiedProjectFile(root, entry.path));
    if (hash(before) !== observed.sha256) fail("PROJECT_COPY_SOURCE_CHANGED");
    // A manifest may contain binary or unknown user data. Only known text
    // projections/canonical JSON with valid UTF-8 and no NUL are repairable.
    const local = entry.path.startsWith(directory + "/") ? entry.path.slice(directory.length + 1) : null;
    const textPath =
      ["AGENTS.md", "CLAUDE.md", ".mcp.json", "opencode.json"].includes(entry.path) ||
      local === "project.json" ||
      /^context\/(?:knowledge|product-model)\.json$/.test(local || "") ||
      /^generated\/[^/]+\.(?:json|md|toml)$/.test(local || "") ||
      /^roles\/(?:head|lode|developer|coder|reviewer)\.md$/.test(local || "") ||
      /^sessions\/records\/session-[a-fA-F0-9-]{36}\.json$/.test(local || "") ||
      /^onboarding\/storage-selections\/[^/]+\.json$/.test(local || "");
    let validText = textPath && !before.includes(0);
    if (validText)
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(before);
      } catch {
        validText = false;
      }
    if (!validText) {
      unresolved.push({ path: entry.path, reasonCode: "MANAGED_NON_TEXT_PRESERVED" });
      continue;
    }
    const intentPath = `${directory}/project-location/byte-repairs/intents/${hash(entry.path + "\n" + entry.sha256)}.json`;
    const intentFile = copiedProjectFile(root, intentPath);
    if (fs.existsSync(intentFile)) {
      inspectCopiedProjectFile(root, intentPath);
      const intent = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(intentFile)));
      if (
        intent?.schemaVersion !== 1 ||
        intent.kind !== "ProjectRecordByteRepair" ||
        intent.path !== entry.path ||
        intent.expectedSha256 !== entry.sha256 ||
        typeof intent.observedSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(intent.observedSha256) ||
        intent.backup !== `${directory}/project-location/byte-repairs/${intent.observedSha256}.bin`
      )
        fail("PROJECT_REPAIR_INTENT_INVALID");
      if (observed.sha256 !== intent.observedSha256) {
        unresolved.push({ path: entry.path, reasonCode: "PROJECT_REPAIR_RETRY_CONFLICT" });
        continue;
      }
    }
    const after = lineEndingVariants(before).find((value) => hash(value) === entry.sha256);
    if (!after) {
      unresolved.push({ path: entry.path, reasonCode: "MANAGED_CONTENT_EDITED" });
      continue;
    }
    repairs.push({
      path: entry.path,
      before,
      after,
      observedSha256: observed.sha256,
      expectedSha256: entry.sha256,
    });
  }
  return { repairs, unresolved, inspectionOnly: true };
}

// Internal explicit-resume support. The caller first validates the exact
// Project, runtime and Session input. Each publication reaches an already
// recorded digest; unresolved files remain untouched and separately reported.
export function repairManagedProjectBytes({ root, directory, manifest, onPublication = null } = {}) {
  inspectManagedByteRepairs({ root, directory, manifest });
  return withLocalMutation({ directory: copiedProjectFile(root, `${directory}/.operations/project-relocation.lock`) }, () => {
    const plan = inspectManagedByteRepairs({ root, directory, manifest });
    const applied = [];
    for (const repair of plan.repairs) {
      const record = {
        schemaVersion: 1,
        kind: "ProjectRecordByteRepair",
        path: repair.path,
        observedSha256: repair.observedSha256,
        expectedSha256: repair.expectedSha256,
        backup: `${directory}/project-location/byte-repairs/${repair.observedSha256}.bin`,
        transformation: "exact-recorded-digest-line-ending-repair",
        instructionAuthority: false,
        recoveryAuthority: false,
      };
      const createExact = (relative, bytes) => {
        const file = copiedProjectFile(root, relative);
        if (fs.existsSync(file)) {
          inspectCopiedProjectFile(root, relative);
          if (!fs.readFileSync(file).equals(Buffer.from(bytes))) fail("PROJECT_REPAIR_BACKUP_CONFLICT");
        } else atomicCreateArtifact(file, bytes);
      };
      createExact(record.backup, repair.before);
      createExact(`${directory}/project-location/byte-repairs/${hash(json(record))}.json`, json(record));
      createExact(`${directory}/project-location/byte-repairs/intents/${hash(repair.path + "\n" + repair.expectedSha256)}.json`, json(record));
      const file = copiedProjectFile(root, repair.path);
      atomicWriteArtifact(file, repair.after, {
        beforePublish() {
          if (inspectCopiedProjectFile(root, repair.path).sha256 !== repair.observedSha256) fail("PROJECT_COPY_SOURCE_CHANGED");
        },
      });
      applied.push({
        path: repair.path,
        beforeSha256: repair.observedSha256,
        afterSha256: repair.expectedSha256,
        backup: record.backup,
      });
      onPublication?.(repair.path);
    }
    return {
      status: applied.length ? "original-bytes-restored" : "unchanged",
      applied,
      unresolved: plan.unresolved,
      wholeProjectReady: false,
      claimsGlobalAtomicity: false,
    };
  });
}

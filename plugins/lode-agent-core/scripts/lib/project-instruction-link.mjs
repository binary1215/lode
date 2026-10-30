import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inspectProject } from "./lode-core.mjs";
import { assertProjectStorageUnchanged, formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";

const START = "<!-- lode-agent:project-instructions -->";
const END = "<!-- /lode-agent:project-instructions -->";
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function validateInstructionIntegration(choice) {
  if (choice != null && choice !== "link" && choice !== "preserve") {
    fail("PROJECT_INSTRUCTION_CHOICE_INVALID", "Instruction integration must be link or preserve.");
  }
  return choice;
}

function safePath(root, relative) {
  const file = path.join(root, relative), fromRoot = path.relative(root, file);
  if (path.isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`)) fail("PATH_ESCAPE", "Instruction path escapes the Project.");
  let current = root;
  for (const segment of fromRoot.split(path.sep)) {
    current = path.join(current, segment);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail("SYMLINK_PATH", "Instruction linking cannot follow a symlink."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return file;
}

function decode(bytes) {
  let body = bytes, encoding = "utf8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = "utf16le"; body = bytes.subarray(2); }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = "utf16be"; body = Buffer.from(bytes.subarray(2)); if (body.length % 2) return null; body.swap16(); }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) body = bytes.subarray(3);
  try {
    if (encoding !== "utf8" && body.length % 2) return null;
    const text = new TextDecoder(encoding === "utf8" ? "utf-8" : "utf-16le", { fatal: true }).decode(body);
    if (text.includes("\0")) return null;
    return { text, encoding, newline: text.match(/\r\n|\n|\r/)?.[0] || "\n" };
  } catch { return null; }
}

function encode(text, encoding) {
  const bytes = Buffer.from(text, encoding === "utf8" ? "utf8" : "utf16le");
  return encoding === "utf16be" ? bytes.swap16() : bytes;
}

// Explicit operation choice only. No consent database, automatic proposal or
// managed ownership of a user's existing instruction file is introduced.
export function linkProjectInstructions({ root = ".", choice } = {}) {
  validateInstructionIntegration(choice);
  if (choice !== "link") return { status: "preserved", files: [], hostConsumption: "not-verified" };
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail("PROJECT_NOT_READY", "Verify affected Project files before linking instructions.");
  const { storage, project } = inspected;
  return withProjectMutation({ root: project.projectRoot, storage, scope: "instruction-link" }, () => {
    if (inspectProject(project.projectRoot).status !== "ready") fail("PROJECT_NOT_READY", "Project files changed before instruction linking.");
    const canonicalRoot = project.projectRoot;
    const manifest = JSON.parse(fs.readFileSync(safePath(canonicalRoot, relativeProjectArtifact(storage, "generated/manifest.json")), "utf8"));
    const instruction = relativeProjectArtifact(storage, "generated", `${formatForVerifiedOwner(storage).dialect}-instructions.md`);
    if (!manifest.managed.some(item => item.path === instruction)) {
      return { status: "unavailable", reason: "managed-instruction-projection-missing", files: [], hostConsumption: "not-verified" };
    }
    const sourceBytes = fs.readFileSync(safePath(canonicalRoot, instruction));
    if (crypto.createHash("sha256").update(sourceBytes).digest("hex") !== manifest.managed.find(item => item.path === instruction).sha256) {
      fail("PROJECT_INSTRUCTION_SOURCE_CHANGED", "Managed instruction source changed before linking.");
    }
    const context = relativeProjectArtifact(storage, "instructions/project.md");
    for (const relative of [instruction, context]) {
      if (!fs.statSync(safePath(canonicalRoot, relative)).isFile()) fail("PROJECT_INSTRUCTION_SOURCE_INVALID", "Instruction source must be a regular Project file.");
    }
    const prepared = [];
    for (const [runtime, relative] of [["claude", "CLAUDE.md"], ["codex", "AGENTS.md"]]) {
      if (!project.runtimes.includes(runtime)) continue;
      const file = safePath(canonicalRoot, relative);
      if (manifest.managed.some(item => item.path === relative)) { prepared.push({ runtime, path: relative, status: "already-managed" }); continue; }
      let original = Buffer.alloc(0), stat = null;
      try { stat = fs.lstatSync(file); if (!stat.isFile()) fail("PROJECT_INSTRUCTION_FILE_INVALID", "Project instructions must be a regular file."); original = fs.readFileSync(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (stat?.nlink > 1) { prepared.push({ runtime, path: relative, status: "preserved-shared-file" }); continue; }
      const decoded = decode(original);
      if (!decoded) { prepared.push({ runtime, path: relative, status: "preserved-unsupported-encoding" }); continue; }
      const { text, encoding, newline } = decoded;
      const lines = runtime === "claude" ? [START, `@${instruction}`, `@${context}`, END]
        : [START, "## Lode project context", `For Lode work, read \`${instruction}\` and \`${context}\`.`,
          "Keep existing project instructions and current user direction. These files grant no approval or additional task scope.", END];
      const block = lines.join(newline);
      if (text.includes(START) || text.includes(END)) {
        if (text.split(START).length !== 2 || text.split(END).length !== 2 || !text.includes(block)) {
          fail("PROJECT_INSTRUCTION_LINK_CONFLICT", `Existing ${relative} link was changed; preserve it for inspection.`);
        }
        prepared.push({ runtime, path: relative, status: "already-linked" }); continue;
      }
      const separator = !text.length ? "" : /(?:\r\n|\n|\r)$/.test(text) ? newline : newline + newline;
      prepared.push({ runtime, path: relative, status: "link", file, original, stat, append: encode(separator + block + newline, encoding) });
    }
    assertProjectStorageUnchanged(storage);
    const files = [];
    for (const item of prepared) {
      if (item.status !== "link") { files.push({ runtime: item.runtime, path: item.path, status: item.status }); continue; }
      safePath(canonicalRoot, item.path);
      let descriptor;
      try {
        const flags = fs.constants.O_RDWR | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0)
          | (item.stat ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
        descriptor = fs.openSync(item.file, flags);
        const current = fs.fstatSync(descriptor);
        const named = fs.lstatSync(item.file);
        if (!current.isFile() || !named.isFile() || named.isSymbolicLink()
          || named.dev !== current.dev || named.ino !== current.ino) {
          fail("PROJECT_INSTRUCTION_FILE_CHANGED", `Project-owned ${item.path} changed before linking.`);
        }
        if (current.nlink > 1 || named.nlink > 1) {
          files.push({ runtime: item.runtime, path: item.path, status: "preserved-shared-file" });
          continue;
        }
        if ((item.stat && (current.dev !== item.stat.dev || current.ino !== item.stat.ino))
          || !fs.readFileSync(descriptor).equals(item.original)) {
          fail("PROJECT_INSTRUCTION_FILE_CHANGED", `Project-owned ${item.path} changed before linking.`);
        }
        // O_APPEND keeps writes from replacing existing bytes. These checks
        // cover observed pre-write changes; arbitrary external editors are not locked.
        const written = fs.writeSync(descriptor, item.append);
        if (written !== item.append.length) fail("PROJECT_INSTRUCTION_LINK_PARTIAL", `Incomplete ${item.path} append; inspect the retained bytes before retrying.`);
        fs.fsyncSync(descriptor);
      } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
      files.push({ runtime: item.runtime, path: item.path, status: "linked" });
    }
    return { status: files.some(item => item.status === "linked") ? "linked" : "unchanged", files, hostConsumption: "not-verified" };
  });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { initializeOrResumeProject } from "../scripts/lib/project-bootstrap.mjs";
import { linkProjectInstructions } from "../scripts/lib/project-instruction-link.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch, tools } from "../scripts/mcp-server.mjs";
import { formatProjectBootstrap } from "../scripts/lib/cli-presentation.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function project(t, original = Buffer.from("# Existing project rules\r\nKeep the user's exact scope.\r\n")) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-instruction-link-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ["CLAUDE.md", "AGENTS.md"]) fs.writeFileSync(path.join(root, file), original);
  return root;
}
function records(root, directory) {
  return fs.readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true }).filter(item => item.isFile())
    .map(item => { const file = path.join(item.parentPath, item.name); return [file, hash(fs.readFileSync(file))]; });
}

test("explicit setup links host-correct instructions once while preserving all Canon and existing bytes", async t => {
  const root = project(t), original = fs.readFileSync(path.join(root, "AGENTS.md"));
  initializeProject({ root, pluginRoot, runtimes: ["codex", "claude"] });
  const before = records(root, ".lode");
  const result = await initializeOrResumeProject({ root, pluginRoot, instructionIntegration: "link" });
  assert.equal(result.instructionIntegration.status, "linked");
  assert.equal(result.instructionIntegration.hostConsumption, "not-verified");
  assert.match(formatProjectBootstrap(result), /Project instructions: linked; actual Host consumption was not verified/);
  for (const file of ["CLAUDE.md", "AGENTS.md"]) assert(fs.readFileSync(path.join(root, file)).subarray(0, original.length).equals(original));
  const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), codex = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.match(claude, /\r\n@\.lode\/generated\/lode-instructions\.md\r\n@\.lode\/instructions\/project\.md\r\n/);
  assert.match(codex, /read `\.lode\/generated\/lode-instructions\.md` and `\.lode\/instructions\/project\.md`/);
  assert.doesNotMatch(codex, /^@/m);
  for (const [file, digest] of before) assert.equal(hash(fs.readFileSync(file)), digest);
  const bytes = [claude, codex];
  const again = await initializeOrResumeProject({ root, pluginRoot, instructionIntegration: "link" });
  assert(again.instructionIntegration.files.every(item => item.status === "already-linked"));
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), bytes[0]);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), bytes[1]);
  assert.equal(inspectProject(root).status, "ready");
});

for (const encoding of ["utf8-bom", "utf16le", "utf16be"]) {
  test(`link preserves ${encoding} BOM, original bytes and CRLF`, t => {
    const text = "# User rules\r\n범위 유지\r\n";
    let original = Buffer.from(text, encoding === "utf8-bom" ? "utf8" : "utf16le");
    if (encoding === "utf16be") original.swap16();
    original = Buffer.concat([encoding === "utf8-bom" ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.from(encoding === "utf16le" ? [0xff, 0xfe] : [0xfe, 0xff]), original]);
    const root = project(t, original);
    initializeProject({ root, pluginRoot, runtimes: ["claude", "codex"] });
    linkProjectInstructions({ root, choice: "link" });
    for (const file of ["CLAUDE.md", "AGENTS.md"]) {
      const result = fs.readFileSync(path.join(root, file));
      assert(result.subarray(0, original.length).equals(original));
      const tail = Buffer.from(result.subarray(original.length));
      if (encoding === "utf16be") tail.swap16();
      const added = tail.toString(encoding === "utf8-bom" ? "utf8" : "utf16le");
      assert(added.includes("lode-agent:project-instructions"));
      assert.doesNotMatch(added.replaceAll("\r\n", ""), /\n/);
      assert.doesNotMatch(added, /\ufeff/);
    }
  });
}

test("default and declined linking preserve files and do not re-offer or block ordinary direct work", async t => {
  const root = project(t), original = fs.readFileSync(path.join(root, "AGENTS.md"));
  const first = await initializeOrResumeProject({ root, pluginRoot, runtimes: ["codex", "claude"], instructionIntegration: "preserve" });
  assert.equal(first.instructionIntegration.status, "preserved");
  const again = await initializeOrResumeProject({ root, pluginRoot });
  assert.equal(again.instructionIntegration, undefined);
  assert.equal(again.nextAction.id, "work_directly");
  assert.doesNotMatch(formatProjectBootstrap(again), /Project instructions:|instruction linking remains/);
  assert(fs.readFileSync(path.join(root, "AGENTS.md")).equals(original));
  assert(fs.readFileSync(path.join(root, "CLAUDE.md")).equals(original));
});

test("the existing CLI setup carries the explicit choice without another API or user form", async t => {
  const root = project(t);
  const result = await runCommand(["init", root, "--runtime", "codex,claude", "--instruction-integration", "link"]);
  assert.equal(result.instructionIntegration.status, "linked");
  assert.equal(inspectProject(root).status, "ready");
});

test("typed MCP exposes and carries the same optional setup choice", async t => {
  const root = project(t);
  const tool = tools.find(item => item.name === "lode_project_initialize_or_resume");
  assert.deepEqual(tool.inputSchema.properties.instruction_integration.enum, ["link", "preserve"]);
  assert(!tool.inputSchema.required.includes("instruction_integration"));
  const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: tool.name, arguments: { project_root: root, runtimes: ["codex", "claude"], instruction_integration: "link" },
  } });
  assert.equal(response.result.structuredContent.instructionIntegration.status, "linked");
});

test("invalid choices and changed or duplicated link blocks fail only the affected link", async t => {
  const root = project(t);
  await assert.rejects(initializeOrResumeProject({ root, pluginRoot, instructionIntegration: "automatic" }), { code: "PROJECT_INSTRUCTION_CHOICE_INVALID" });
  assert.equal(inspectProject(root).status, "not_initialized");
  initializeProject({ root, pluginRoot, runtimes: ["codex", "claude"] });
  linkProjectInstructions({ root, choice: "link" });
  fs.appendFileSync(path.join(root, "CLAUDE.md"), "<!-- lode-agent:project-instructions -->\r\n");
  const codex = fs.readFileSync(path.join(root, "AGENTS.md"));
  assert.throws(() => linkProjectInstructions({ root, choice: "link" }), { code: "PROJECT_INSTRUCTION_LINK_CONFLICT" });
  assert(fs.readFileSync(path.join(root, "AGENTS.md")).equals(codex));
  assert.equal(inspectProject(root).status, "ready");
});

test("unknown file encoding is preserved and does not stop Core work", t => {
  const original = Buffer.from([0x80, 0x81, 0x0d, 0x0a]), root = project(t, original);
  initializeProject({ root, pluginRoot, runtimes: ["claude", "codex"] });
  const result = linkProjectInstructions({ root, choice: "link" });
  assert(result.files.every(item => item.status === "preserved-unsupported-encoding"));
  for (const file of ["CLAUDE.md", "AGENTS.md"]) assert(fs.readFileSync(path.join(root, file)).equals(original));
  assert.equal(inspectProject(root).status, "ready");
});

test("symlink and dangling-symlink targets are refused before any other host document is appended", t => {
  const root = project(t), outside = path.join(root, "owned-fixture-outside.md"), target = path.join(root, "CLAUDE.md");
  initializeProject({ root, pluginRoot, runtimes: ["claude", "codex"] });
  const codex = fs.readFileSync(path.join(root, "AGENTS.md"));
  fs.writeFileSync(outside, "untouched"); fs.unlinkSync(target);
  try { fs.symlinkSync(outside, target, "file"); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("File symlink creation unavailable on this Windows Host"); return; } throw error; }
  assert.throws(() => linkProjectInstructions({ root, choice: "link" }), { code: "SYMLINK_PATH" });
  fs.unlinkSync(outside);
  assert.throws(() => linkProjectInstructions({ root, choice: "link" }), { code: "SYMLINK_PATH" });
  assert(fs.readFileSync(path.join(root, "AGENTS.md")).equals(codex));
});

test("a synthetic legacy Project links only its validated .head sources without creating .lode", t => {
  const root = project(t), base = path.join(root, ".head");
  fs.mkdirSync(path.join(base, "generated"), { recursive: true }); fs.mkdirSync(path.join(base, "instructions")); fs.mkdirSync(path.join(base, "sessions"));
  const legacyProject = { schemaVersion: 1, projectId: `head-${hash(root).slice(0, 20)}`, projectRoot: root, runtimes: ["claude", "codex"], integrations: {}, authority: { head: "fixture", user: "fixture" } };
  fs.writeFileSync(path.join(base, "project.json"), JSON.stringify(legacyProject));
  fs.writeFileSync(path.join(base, "sessions/current.json"), JSON.stringify({ schemaVersion: 1, sessionId: `session-${crypto.randomUUID()}`, mode: "session" }));
  fs.writeFileSync(path.join(base, "generated/head-instructions.md"), "# Historical HEAD fixture\n");
  fs.writeFileSync(path.join(base, "instructions/project.md"), "# Synthetic project context\n");
  fs.writeFileSync(path.join(base, "generated/manifest.json"), JSON.stringify({ schemaVersion: 1, managed: [".head/project.json", ".head/generated/head-instructions.md"].map(relative => ({ path: relative, sha256: hash(fs.readFileSync(path.join(root, relative))) })) }));
  const before = records(root, ".head");
  assert.equal(linkProjectInstructions({ root, choice: "link" }).status, "linked");
  assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /@\.head\/generated\/head-instructions\.md/);
  assert.equal(fs.existsSync(path.join(root, ".lode")), false);
  for (const [file, digest] of before) assert.equal(hash(fs.readFileSync(file)), digest);
});

test("a symlinked generated-source directory cannot broaden an approved root link", t => {
  const root = project(t);
  initializeProject({ root, pluginRoot, runtimes: ["claude", "codex"] });
  const source = path.join(root, ".lode/generated"), retained = path.join(root, "owned-retained-generated");
  const original = fs.readFileSync(path.join(root, "CLAUDE.md"));
  fs.renameSync(source, retained);
  fs.symlinkSync(retained, source, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => linkProjectInstructions({ root, choice: "link" }), { code: "SYMLINK_PATH" });
  assert(fs.readFileSync(path.join(root, "CLAUDE.md")).equals(original));
});

test("hard-linked project-owned text is preserved without modifying its other owner", t => {
  const root = project(t), target = path.join(root, "CLAUDE.md"), sibling = path.join(root, "owned-fixture-linked-text.md");
  initializeProject({ root, pluginRoot, runtimes: ["claude"] });
  fs.linkSync(target, sibling);
  const original = fs.readFileSync(sibling), result = linkProjectInstructions({ root, choice: "link" });
  assert.equal(result.files[0].status, "preserved-shared-file");
  assert(fs.readFileSync(sibling).equals(original));
  assert(fs.readFileSync(target).equals(original));
  assert.match(formatProjectBootstrap({ instructionIntegration: result }), /originals are preserved and ordinary work continues/);
});

function interceptAppendOpen(t, target, effect, afterOpen = false) {
  const open = fs.openSync;
  let invoked = false;
  t.mock.method(fs, "openSync", function(file, flags, ...rest) {
    if (file !== target || typeof flags !== "number" || !(flags & fs.constants.O_APPEND) || invoked) {
      return open.call(this, file, flags, ...rest);
    }
    invoked = true;
    if (!afterOpen) effect();
    const descriptor = open.call(this, file, flags, ...rest);
    if (afterOpen) effect(descriptor);
    return descriptor;
  });
  return () => assert(invoked, "the actual append-open boundary was exercised");
}

test("a hardlink introduced at append-open is preserved and does not block the other document", t => {
  const root = project(t), target = path.join(root, "CLAUDE.md"), sibling = path.join(root, "other-owner.md");
  initializeProject({ root, pluginRoot, runtimes: ["claude", "codex"] });
  const original = fs.readFileSync(target);
  const exercised = interceptAppendOpen(t, target, () => fs.linkSync(target, sibling));
  const result = linkProjectInstructions({ root, choice: "link" });
  exercised();
  assert.deepEqual(result.files.map(item => [item.path, item.status]), [["CLAUDE.md", "preserved-shared-file"], ["AGENTS.md", "linked"]]);
  assert(fs.readFileSync(target).equals(original));
  assert(fs.readFileSync(sibling).equals(original));
  assert.match(formatProjectBootstrap({ instructionIntegration: result }), /CLAUDE\.md: preserved \(shared file\); AGENTS\.md: linked/);
  assert.equal(inspectProject(root).status, "ready");
});

for (const kind of ["bytes", "inode", "named-path"]) {
  test(`an external ${kind} change at append-open retains the external file without appending`, t => {
    const root = project(t), target = path.join(root, "CLAUDE.md"), retained = path.join(root, "original-owner.md");
    initializeProject({ root, pluginRoot, runtimes: ["claude", "codex"] });
    const codex = fs.readFileSync(path.join(root, "AGENTS.md"));
    const replacement = Buffer.from("# External editor owns these bytes\n");
    const exercised = interceptAppendOpen(t, target, () => {
      if (kind !== "bytes") fs.renameSync(target, retained);
      fs.writeFileSync(target, replacement);
    }, kind === "named-path");
    assert.throws(() => linkProjectInstructions({ root, choice: "link" }), { code: "PROJECT_INSTRUCTION_FILE_CHANGED" });
    exercised();
    assert(fs.readFileSync(target).equals(replacement));
    assert(fs.readFileSync(path.join(root, "AGENTS.md")).equals(codex));
    assert.equal(inspectProject(root).status, "ready");
  });
}

test("a newly created document also detects external bytes before append", t => {
  const root = project(t), target = path.join(root, "CLAUDE.md");
  fs.writeFileSync(path.join(root, ".mcp.json"), "{}");
  // Initialize while the user-owned document exists, then remove that unowned
  // file. Missing initial files are now intentionally created by Core setup.
  initializeProject({ root, pluginRoot, runtimes: ["claude"] });
  fs.unlinkSync(target);
  assert.equal(fs.existsSync(target), false);
  const replacement = Buffer.from("# External text after exclusive creation\n");
  const exercised = interceptAppendOpen(t, target, () => fs.appendFileSync(target, replacement), true);
  assert.throws(() => linkProjectInstructions({ root, choice: "link" }), { code: "PROJECT_INSTRUCTION_FILE_CHANGED" });
  exercised();
  assert(fs.readFileSync(target).equals(replacement));
});

test("partial append is retained without rollback and retry does not append another block", t => {
  const root = project(t), target = path.join(root, "CLAUDE.md");
  initializeProject({ root, pluginRoot, runtimes: ["claude", "codex"] });
  const original = fs.readFileSync(target), write = fs.writeSync;
  let targetDescriptor;
  const exercised = interceptAppendOpen(t, target, descriptor => { targetDescriptor = descriptor; }, true);
  t.mock.method(fs, "writeSync", function(descriptor, bytes, ...rest) {
    if (descriptor === targetDescriptor) {
      targetDescriptor = undefined;
      const partial = bytes.subarray(0, bytes.indexOf(Buffer.from("<!-- /lode-agent:")));
      return write.call(this, descriptor, partial);
    }
    return write.call(this, descriptor, bytes, ...rest);
  });
  assert.throws(() => linkProjectInstructions({ root, choice: "link" }), { code: "PROJECT_INSTRUCTION_LINK_PARTIAL" });
  exercised();
  const partial = fs.readFileSync(target);
  assert(partial.subarray(0, original.length).equals(original));
  assert(partial.length > original.length);
  assert.throws(() => linkProjectInstructions({ root, choice: "link" }), { code: "PROJECT_INSTRUCTION_LINK_CONFLICT" });
  assert(fs.readFileSync(target).equals(partial));
});

test("mixed unsupported-encoding and linked documents are visible without JSON", t => {
  const root = project(t), target = path.join(root, "CLAUDE.md"), original = Buffer.from([0x80, 0x81]);
  fs.writeFileSync(target, original);
  initializeProject({ root, pluginRoot, runtimes: ["claude", "codex"] });
  const result = linkProjectInstructions({ root, choice: "link" });
  assert.equal(result.status, "linked");
  assert(fs.readFileSync(target).equals(original));
  const text = formatProjectBootstrap({ instructionIntegration: result });
  assert.match(text, /CLAUDE\.md: preserved \(unsupported encoding\); AGENTS\.md: linked/);
  assert.match(text, /ordinary work continues/);
  assert.match(text, /actual Host consumption was not verified/i);
});

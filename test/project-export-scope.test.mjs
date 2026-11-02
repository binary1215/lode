import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fixture, pluginRoot, snapshot } from "./helpers/session-work-linkage-fixture.mjs";
import { createLodeSession, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { recordSessionWorkEvidence } from "../scripts/lib/session-work-context.mjs";
import {
  exportProjectBundle,
  inspectProjectBundle,
  importProjectBundle,
} from "../scripts/lib/project-portability.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch, catalogTools } from "../scripts/mcp-server.mjs";
const sha = (raw) => crypto.createHash("sha256").update(raw).digest("hex");
test("default legacy export includes required raw proof metadata, not other Session bodies; opt-out stays partial", async (t) => {
  const f = fixture(t);
  f.save({ summary: "SELECTED_PORTABLE_EVIDENCE" });
  const other = createLodeSession({ root: f.root, purpose: "OTHER_SESSION_BODY_SENTINEL" });
  withSessionRoute(f.root, other.sessionId, () =>
    recordSessionWorkEvidence({
      root: f.root,
      input: { summary: "OTHER_SESSION_WORK_SENTINEL" },
    }),
  );
  const projectFile = path.join(f.root, ".lode/project.json"),
    project = JSON.parse(fs.readFileSync(projectFile));
  fs.writeFileSync(
    projectFile,
    JSON.stringify(
      { ...project, projectRoot: "C:/unverified-origin/synthetic-project" },
      null,
      2,
    ) + "\n",
  );
  const mf = path.join(f.root, ".lode/generated/manifest.json"),
    generated = JSON.parse(fs.readFileSync(mf));
  generated.managed.find((entry) => entry.path === ".lode/project.json").sha256 = sha(
    fs.readFileSync(projectFile),
  );
  fs.writeFileSync(mf, JSON.stringify(generated, null, 2) + "\n");
  await runCommand([
    "resume",
    f.root,
    "--copied-project",
    "verified-copy",
    "--session",
    f.session.sessionId,
  ]);
  const before = snapshot(f.root),
    destination = path.join(f.base, "full-proof");
  let notices = 0;
  const exported = f.route(() =>
    exportProjectBundle({
      root: f.root,
      destination,
      onExportScope(notice) {
        notices++;
        assert(!fs.existsSync(destination));
        assert.equal(notice.provenanceScope, "project-proof-metadata");
        assert.equal(notice.requiredProofMayMentionOtherSessions, true);
        assert.equal(notice.otherSessionBodiesIncluded, false);
        assert.equal(notice.authorityPlane, "P4");
        assert.equal(notice.persisted, false);
      },
    }),
  );
  assert.equal(notices, 1);
  assert.equal(exported.status, "exported");
  assert.equal(exported.projectAdmissionReady, true);
  const inspected = inspectProjectBundle({ bundleRoot: destination });
  assert.equal(inspected.projectAdmissionReady, true);
  assert(!Object.hasOwn(inspected.manifest, "exportScope"));
  const inventory = inspected.manifest.files.find((entry) =>
    entry.path.includes("/copy-originals/"),
  );
  assert(inventory);
  assert.deepEqual(
    fs.readFileSync(path.join(destination, "objects", inventory.sha256 + ".bin")),
    fs.readFileSync(path.join(f.root, inventory.path)),
  );
  const contents = inspected.manifest.files
    .map((entry) =>
      fs.readFileSync(path.join(destination, "objects", entry.sha256 + ".bin"), "utf8"),
    )
    .join("\n");
  assert(
    contents.includes(other.sessionId),
    "Original shared inventory retains required other-Session IDs/paths/hashes",
  );
  assert(!contents.includes("OTHER_SESSION_BODY_SENTINEL"));
  assert(!contents.includes("OTHER_SESSION_WORK_SENTINEL"));
  assert(
    !inspected.manifest.files.some((entry) =>
      entry.path.includes("/by-id/" + other.sessionId + "/"),
    ),
  );
  const explicit = f.route(() =>
    exportProjectBundle({
      root: f.root,
      destination: path.join(f.base, "explicit-full"),
      provenanceScope: "project-proof-metadata",
    }),
  );
  assert.equal(explicit.bundleId, exported.bundleId);
  const partial = f.route(() =>
    exportProjectBundle({
      root: f.root,
      destination: path.join(f.base, "selected-only"),
      provenanceScope: "selected-only",
    }),
  );
  assert.equal(partial.status, "exported-partial-provenance");
  assert.equal(partial.projectAdmissionReady, false);
  assert.equal(
    inspectProjectBundle({ bundleRoot: partial.bundleRoot }).projectAdmissionReady,
    false,
  );
  const fresh = path.join(f.base, "imported");
  fs.mkdirSync(fresh);
  assert.equal(
    importProjectBundle({ root: fresh, bundleRoot: destination, pluginRoot }).status,
    "imported",
  );
  assert.deepEqual(snapshot(f.root), before);
});
test("Core, CLI and typed MCP publish scope before effects without any acknowledgement or extra tool", async (t) => {
  const f = fixture(t);
  let calls = 0;
  for (const consumer of ["core", "cli", "mcp"]) {
    const destination = path.join(f.base, consumer),
      onExportScope = (notice) => {
        calls++;
        assert(!fs.existsSync(destination));
        assert.equal(notice.provenanceScope, "project-proof-metadata");
        assert.equal(notice.otherSessionBodiesIncluded, false);
      };
    if (consumer === "core") exportProjectBundle({ root: f.root, destination, onExportScope });
    else if (consumer === "cli")
      await runCommand(["project-export", f.root, "--destination", destination], {
        onExportScope,
      });
    else {
      const response = await dispatch(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "lode_project_bundle_export",
            arguments: { project_root: f.root, destination },
          },
        },
        { onExportScope },
      );
      assert(!response.error, JSON.stringify(response));
      assert.equal(
        response.result.structuredContent.exportScope.provenanceScope,
        "project-proof-metadata",
      );
    }
  }
  assert.equal(calls, 3);
  const denied = Object.assign(Error("Synthetic notice delivery failed"), {
      code: "SYNTHETIC_NOTICE_FAILED",
    }),
    destination = path.join(f.base, "not-created");
  assert.throws(
    () =>
      exportProjectBundle({
        root: f.root,
        destination,
        onExportScope() {
          throw denied;
        },
      }),
    (error) => error === denied,
  );
  assert(!fs.existsSync(destination));
  const raw = exportProjectBundle({
    root: f.root,
    destination: path.join(f.base, "raw-api-without-observer"),
  });
  assert.equal(raw.status, "exported");
  const tool = catalogTools.find((tool) => tool.name === "lode_project_bundle_export");
  assert.equal(tool.inputSchema.properties.provenance_scope.default, "project-proof-metadata");
  assert.match(tool.description, /Before invoking export/);
});
const wireScript = String.raw`
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const root=process.env.LODE_TEST_EXPORT_ROOT,destination=process.env.LODE_TEST_EXPORT_DEST,plugin=process.env.LODE_TEST_EXPORT_PLUGIN,mode=process.env.LODE_TEST_EXPORT_MODE;
let scope=false;const realWrite=fs.writeSync,realMkdir=fs.mkdirSync;
fs.writeSync=function(fd,data,...args){if(fd===2&&String(data).includes('projectExportScope')){assert(!fs.existsSync(destination));scope=true;}return realWrite.call(this,fd,data,...args);};
fs.mkdirSync=function(file,...args){if(path.resolve(file)===path.resolve(destination))assert(scope,'Scope must be emitted before the first destination effect');return realMkdir.call(this,file,...args);};
if(mode==='cli'){const {runCliMain}=await import(pathToFileURL(path.join(plugin,'scripts/lode.mjs')).href);await runCliMain(['project-export',root,'--destination',destination,'--json']);assert(scope);}
else{const {serveMcp}=await import(pathToFileURL(path.join(plugin,'scripts/mcp-server.mjs')).href);serveMcp({nativeSessionBridge:null});}
`;
for (const mode of ["cli", "mcp"])
  test(mode + " wire emits a pre-copy scope notice and keeps stdout JSON intact", async (t) => {
    const f = fixture(t),
      destination = path.join(f.base, "wire-" + mode);
    const child = spawn(process.execPath, ["--input-type=module", "-e", wireScript], {
      cwd: pluginRoot,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        LODE_TEST_EXPORT_ROOT: f.root,
        LODE_TEST_EXPORT_DEST: destination,
        LODE_TEST_EXPORT_PLUGIN: pluginRoot,
        LODE_TEST_EXPORT_MODE: mode,
        HEAD_AGENT_OPERATIONAL_STATE_ROOT: f.operational,
      },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }, 20000);
    t.after(() => clearTimeout(timer));
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (mode === "mcp")
      child.stdin.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "synthetic-export-client", version: "1" },
            capabilities: {},
            protocolVersion: "2024-11-05",
          },
        }) +
          "\n" +
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "lode_project_bundle_export",
              arguments: { project_root: f.root, destination },
            },
          }) +
          "\n",
      );
    else child.stdin.end();
    const exit = await closed;
    assert.equal(exit.code, 0, stderr + "\n" + stdout);
    assert.equal(exit.signal, null);
    const notice = stderr
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .find((value) => value.projectExportScope);
    assert.equal(notice.projectExportScope.provenanceScope, "project-proof-metadata");
    const value =
      mode === "cli"
        ? JSON.parse(stdout)
        : stdout
            .trim()
            .split(/\r?\n/)
            .map((line) => JSON.parse(line))
            .find((value) => value.id === 2).result.structuredContent;
    assert.equal(value.status, "exported");
    assert.equal(value.exportScope.otherSessionBodiesIncluded, false);
    assert(fs.existsSync(path.join(destination, "manifest.json")));
  });

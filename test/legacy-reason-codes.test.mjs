import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LEGACY_REASON_CODES, legacyReasonCode, legacyReasonCodeFields, REASON_CODES } from "../scripts/lib/core/errors.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";

// Stage 3-D (user decision 2): reason codes no longer spell the product name
// HEAD. Each historical code is carried for one version as legacyReasonCode.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every legacy code names the HEAD product and maps to one current code", () => {
  const emitted = new Set(REASON_CODES);
  const values = Object.values(LEGACY_REASON_CODES);
  assert.ok(values.length > 0);
  assert.equal(new Set(values).size, values.length);
  for (const [legacy, code] of Object.entries(LEGACY_REASON_CODES)) {
    assert.match(legacy, /(^|_)HEAD(_|$)/);
    assert.equal(emitted.has(legacy), false, `${legacy} is still emitted`);
    assert.match(code, /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/);
    assert.doesNotMatch(code, /(^|_)HEAD(_|$)/);
    assert.equal(legacyReasonCode(code), legacy);
  }
  assert.equal(legacyReasonCode("UNSUPPORTED_GC_GIT_HEAD"), undefined);
  assert.equal(legacyReasonCode("NOT_A_CODE"), undefined);
});

test("MCP errors carry reasonCode and the legacy code", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-legacy-code-"));
  const response = await dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "lode_project_status", arguments: { project_root: root, session_id: "bad id!" } },
  });
  assert.deepEqual(response.error.data, { reasonCode: "INVALID_SESSION_ID", legacyReasonCode: "INVALID_HEAD_SESSION_ID" });
});

test("CLI JSON failures without a code carry the default and its legacy code", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lode-legacy-cli-"));
  const result = spawnSync(process.execPath, [path.join(repo, "scripts", "lode.mjs"), "status", "--session", "bad id!", "--json"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stdout || result.stderr);
  assert.equal(failure.code, "CLI_ERROR");
  assert.equal(failure.legacyReasonCode, "HEAD_CLI_ERROR");
});

test("CLI JSON session-id failures carry the legacy code", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lode-legacy-cli-"));
  const result = spawnSync(process.execPath, [path.join(repo, "scripts", "lode.mjs"), "status", ".", "--session", "bad-id", "--json"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stdout);
  assert.equal(failure.code, "INVALID_SESSION_ID");
  assert.equal(failure.legacyReasonCode, "INVALID_HEAD_SESSION_ID");
});

test("a code without a legacy spelling carries no legacyReasonCode key", async () => {
  assert.deepEqual(legacyReasonCodeFields("INVALID_SESSION_CANON"), {});
  assert.deepEqual(legacyReasonCodeFields("SESSION_SELECTION_LOST"), { legacyReasonCode: "HEAD_SESSION_SELECTION_LOST" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-legacy-code-"));
  const response = await dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "lode_session_restore", arguments: { project_root: root, session_id: "session-00000000-0000-4000-8000-000000000009" } },
  });
  assert.equal(response.error.data.reasonCode, "INVALID_SESSION_CANON");
  assert.equal(Object.hasOwn(response.error.data, "legacyReasonCode"), false);
});

test("distribution JSON failures carry the legacy code", () => {
  const installRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lode-legacy-dist-")), "none");
  const result = spawnSync(process.execPath, [path.join(repo, "scripts", "distribution.mjs"), "status", "--install-root", installRoot], { encoding: "utf8" });
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stdout);
  assert.equal(failure.code, "DISTRIBUTION_OWNERSHIP_INVALID");
  assert.equal(failure.legacyReasonCode, "HEAD_DISTRIBUTION_OWNERSHIP_INVALID");
});

test("MCP result bodies carry the legacy code next to a Session reasonCode", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-legacy-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot: repo, runtimes: ["codex"] });
  const sessionId = inspectProject(root).state.sessionId;
  const options = {
    resolveSessionContext() {
      throw new Error("Synthetic unavailable binding");
    },
  };
  const call = (name, args) => dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, options);
  const explicit = await call("lode_project_status", { project_root: root, session_id: sessionId });
  assert.equal(explicit.error, undefined);
  assert.equal(explicit.result._meta.headSessionBinding.reasonCode, "SESSION_CONTEXT_UNAVAILABLE");
  assert.equal(explicit.result._meta.headSessionBinding.legacyReasonCode, "HEAD_SESSION_CONTEXT_UNAVAILABLE");
  const unresolved = await call("lode_project_status", { project_root: root });
  assert.equal(unresolved.result.structuredContent.status, "session_selection_unresolved");
  assert.equal(unresolved.result.structuredContent.reasonCode, "SESSION_CONTEXT_UNAVAILABLE");
  assert.equal(unresolved.result.structuredContent.legacyReasonCode, "HEAD_SESSION_CONTEXT_UNAVAILABLE");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LEGACY_REASON_CODES, legacyReasonCode, REASON_CODES } from "../scripts/lib/core/errors.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";

// Stage 3-D (user decision 2): reason codes no longer spell the product name
// HEAD. Each historical code is carried for one version as legacyReasonCode.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every legacy code names the HEAD product and maps to one current code", () => {
  const emitted = new Set(REASON_CODES);
  const values = Object.values(LEGACY_REASON_CODES);
  assert.ok(values.length > 0);
  assert.equal(new Set(values).size, values.length);
  for (const [legacy, code] of Object.entries(LEGACY_REASON_CODES)) {
    assert.match(legacy, /(^|_)HEAD_/);
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

test("CLI JSON failures carry the code and the legacy code", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lode-legacy-cli-"));
  const result = spawnSync(process.execPath, [path.join(repo, "scripts", "lode.mjs"), "status", "--session", "bad id!", "--json"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stdout || result.stderr);
  assert.equal(failure.code, "CLI_ERROR");
  assert.equal(failure.legacyReasonCode, "HEAD_CLI_ERROR");
});

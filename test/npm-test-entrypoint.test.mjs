import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("npm test builds the supervisor fixture instead of requiring a CI-only environment variable", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/run-tests.mjs");
  const runner = fs.readFileSync(path.join(root, "scripts", "run-tests.mjs"), "utf8");
  assert.match(runner, /"build"/);
  assert.match(runner, /lode-agent-supervisor/);
  assert.match(runner, /LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT/);
  assert.doesNotMatch(runner, /skip\(/);
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "go-worker-build-release.yml"), "utf8");
  assert.match(workflow, /os: \[windows-latest, macos-latest\]/);
  const host = workflow.split("host_smoke:")[1].split("\n  test:")[0];
  assert.match(host, /npm test/);
  assert.doesNotMatch(host, /native-smoke-cleanup\.test\.mjs/);
});

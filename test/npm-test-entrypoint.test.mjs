import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

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


test("automatic fixture rebuilds changed Go sources while explicit CI fixture remains caller-owned", t => {
  const probe = spawnSync("go", ["version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (probe.error?.code === "ENOENT") return t.skip("Local Go toolchain unavailable; required Go-equipped CI executes this regression.");
  assert.equal(probe.status, 0, probe.stderr);
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lode-test-fixture-source-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  fs.mkdirSync(path.join(sandbox, "scripts"));
  fs.copyFileSync(path.join(root, "scripts/run-tests.mjs"), path.join(sandbox, "scripts/run-tests.mjs"));
  fs.cpSync(path.join(root, "scripts/lib"), path.join(sandbox, "scripts/lib"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ version: "0.3.0-beta.80", type: "module" }));
  fs.mkdirSync(path.join(sandbox, "test"));
  fs.writeFileSync(path.join(sandbox, "test/synthetic.test.mjs"), 'import test from "node:test"; test("fixture admitted", () => {});\n');
  const source = path.join(sandbox, "native/lode-agent-worker/cmd/lode-agent-supervisor");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "../../go.mod"), "module synthetic.fixture\n\ngo 1.23\n");
  const code = marker => 'package main\nimport "fmt"\nvar version = "dev"\nfunc main(){fmt.Println(version + "' + marker + '")}\n';
  const input = path.join(source, "main.go"); fs.writeFileSync(input, code("first"));
  const env = { ...process.env }; delete env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT;
  const run = environment => {
    t.diagnostic(JSON.stringify({ event: "planned-synthetic-fixture-run", command: process.execPath, args: ["scripts/run-tests.mjs"], cwd: sandbox, ports: [], windowsHide: true }));
    const result = spawnSync(process.execPath, ["scripts/run-tests.mjs"], { cwd: sandbox, env: environment, encoding: "utf8", windowsHide: true, timeout: 120_000 });
    t.diagnostic(JSON.stringify({ event: "synthetic-fixture-run-exited", pid: result.pid, status: result.status, cwd: sandbox, ports: [] }));
    assert.equal(result.status, 0, result.stderr + result.stdout); return result;
  };
  run(env);
  const binary = path.join(sandbox, ".cache/lode-supervisor-fixture/dist", (process.platform === "win32" ? "windows" : process.platform) + "-" + process.arch, "lode-agent-supervisor" + (process.platform === "win32" ? ".exe" : ""));
  const digest = () => crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  const first = digest(); fs.writeFileSync(input, code("second")); run(env); assert.notEqual(digest(), first);
  const second = digest(); fs.writeFileSync(input, "invalid Go source");
  run({ ...env, LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT: path.join(sandbox, ".cache/lode-supervisor-fixture") });
  assert.equal(digest(), second);
});

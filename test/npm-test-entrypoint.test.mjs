import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { checkSkips, classify, readLedger, runsInCi } from "../scripts/test-skip-ledger.mjs";

const root = path.resolve(import.meta.dirname, "..");
const goos = process.platform === "win32" ? "windows" : process.platform;
const supervisorName = process.platform === "win32" ? "lode-agent-supervisor.exe" : "lode-agent-supervisor";
const PROFILE_NAMES = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
];
const TEST_FIXTURE_NAMES = [
  "LODE_AGENT_TEST_OWNER_CRASH_FIXTURE",
  "HEAD_AGENT_TEST_OWNER_CRASH_FIXTURE",
  "LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT",
  "HEAD_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT",
];
const FIXTURE_NAMES = [
  "LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT",
  "HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT",
  "LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT",
  "HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT",
];

test("npm test builds the supervisor fixture instead of requiring a CI-only environment variable", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/run-tests.mjs");
  const runner = fs.readFileSync(path.join(root, "scripts", "run-tests.mjs"), "utf8");
  assert.match(runner, /"build"/);
  assert.match(runner, /lode-agent-supervisor/);
  assert.match(runner, /LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT/);
  assert.doesNotMatch(runner, /skip\(/);
  assert.doesNotMatch(runner, /does not skip/);
  const host = workflowJobs().get("host_smoke");
  assert.match(host, /os: \[windows-latest, macos-latest\]/);
  assert.match(host, /npm test/);
  assert.doesNotMatch(host, /native-smoke-cleanup\.test\.mjs/);
});

function workflowJobs() {
  const lines = fs.readFileSync(path.join(root, ".github", "workflows", "go-worker-build-release.yml"), "utf8").split(/\r?\n/);
  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(lines.indexOf("jobs:") + 1)) {
    const start = /^ {2}([a-z_]+):$/.exec(line);
    if (start) jobs.set((current = start[1]), []);
    else if (current) jobs.get(current).push(line);
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join("\n")]));
}

test("every workflow job has a time limit and the host jobs run the Go tests before the JavaScript suite", () => {
  const jobs = workflowJobs();
  assert.deepEqual([...jobs.keys()], ["prepare", "javascript", "host_smoke", "test", "build", "release", "marketplace", "claude_marketplace"]);
  for (const [name, body] of jobs) {
    const limit = /^ {4}timeout-minutes: (\d+)$/m.exec(body);
    assert.ok(limit, `${name} has timeout-minutes`);
    assert.ok(Number(limit[1]) >= 15, `${name} timeout-minutes is at least 15`);
  }
  const host = jobs.get("host_smoke");
  // -v, so the log names every Go test that ran and every one that skipped.
  const goTest = host.indexOf("run: go test -v ./...");
  assert.ok(host.indexOf("run: go mod verify") > 0 && host.indexOf("run: go vet ./...") > 0 && goTest > 0, "host_smoke runs go mod verify, go vet and go test");
  assert.ok(goTest < host.indexOf("run: npm test"), "Go tests run before the JavaScript suite");
  for (const job of ["javascript", "host_smoke"]) {
    const exported = /for name in ([A-Z_ ]+); do\n\s+echo "\$\{name\}=\$\{LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT\}" >> "\$\{GITHUB_ENV\}"/.exec(
      jobs.get(job),
    );
    assert.ok(exported, `${job} exports the fixture root`);
    assert.deepEqual(exported[1].trim().split(/\s+/).sort(), [...FIXTURE_NAMES].sort(), `${job} exports every fixture name`);
  }
  const goJob = jobs.get("test");
  assert.match(goJob, /run: go test -v \.\/\.\.\./, "the Linux Go job names every Go test that ran and every one that skipped");
  assert.match(goJob, /verifies Go worker distribution identity and discloses safe JavaScript fallback/);
  assert.match(goJob, /LODE_AGENT_GO_WORKER_FIXTURE_ROOT=/);
  assert.match(goJob, /HEAD_AGENT_GO_WORKER_FIXTURE_ROOT=/);
});

test("no test file declares a skip that cannot carry a reason", () => {
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "fixtures") walk(file);
      } else if (entry.name.endsWith(".mjs")) {
        fs.readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (/\b(?:test|it|describe)\.skip\b|\bt\.skip\(\s*\)|\bskip:\s*true\b|\bskip:\s*process\.platform\s*[!=]==\s*"[a-z0-9]+"\s*[,}]/.test(line)) {
              offenders.push(`${path.relative(root, file).split(path.sep).join("/")}:${index + 1}`);
            }
          });
      }
    }
  };
  walk(path.join(root, "test"));
  assert.deepEqual(offenders, [], 'write { skip: condition && "<class>: reason" } or t.skip("<class>: reason")');
});

test("the checked-in skip ledger declares its classes and keeps sorted lists per operating system", () => {
  const ledger = readLedger();
  assert.deepEqual(Object.keys(ledger.classes).sort(), ["ci-step", "filesystem", "host-limit", "native-fixture", "no-source", "opt-in", "other-os"]);
  for (const [name, declared] of Object.entries(ledger.classes)) {
    assert.equal(typeof declared.pinned, "boolean", name);
    assert.ok(declared.bounded === undefined || typeof declared.bounded === "boolean", name);
    assert.ok(!(declared.pinned && declared.bounded), `${name} is pinned or bounded, not both`);
    assert.ok(declared.meaning.length > 20, name);
  }
  assert.equal(ledger.classes["opt-in"].bounded, true, "opt-in skips are bounded by a list");
  assert.match(ledger.classes["host-limit"].meaning, /In CI \(CI=true\) every host-limit skip fails the run/);
  assert.deepEqual(Object.keys(ledger.skips).sort(), ["darwin", "linux", "win32"]);
  for (const [platform, classes] of Object.entries(ledger.skips)) {
    for (const [name, tests] of Object.entries(classes)) {
      assert.ok(ledger.classes[name]?.pinned || ledger.classes[name]?.bounded, `${platform} lists only pinned or bounded classes, not ${name}`);
      assert.deepEqual(tests, [...tests].sort(), `${platform} ${name} is sorted`);
    }
    // A developer machine may lack these programs; CI has them, so CI never shows these skips.
    for (const test of [
      "test/head-core.test.mjs > Git CLI history excludes Host-only commits and decorations while retaining product refs",
      "test/npm-test-entrypoint.test.mjs > automatic fixture rebuilds changed Go sources while explicit CI fixture remains caller-owned",
      "test/source-context-workflow.test.mjs > modern Python mapping-rest binding cannot resolve to a same-name module function",
    ]) {
      assert.ok(classes["opt-in"]?.includes(test), `${platform} opt-in list allows ${test}`);
    }
  }
  assert.deepEqual(ledger.skips.win32["native-fixture"] ?? [], [], "no native-fixture skip is pinned on Windows");
});

test("skip checks: R1 reason, R2 declared class, R3 Windows native fixture, R4 pinned lists in a full run only, H host-limit in CI", () => {
  const ledger = {
    classes: {
      "other-os": { pinned: true, meaning: "x" },
      "native-fixture": { pinned: true, meaning: "x" },
      "opt-in": { pinned: false, meaning: "x" },
      "host-limit": { pinned: false, meaning: "x" },
    },
    skips: { linux: { "other-os": ["test/a.test.mjs > kept", "test/a.test.mjs > slept"] } },
  };
  const skip = (test, reason) => ({ kind: "skip", file: "test/a.test.mjs", test, reason });
  assert.equal(classify(true, ledger).problem, "R1");
  assert.equal(classify("", ledger).problem, "R1");
  assert.equal(classify("no class here", ledger).problem, "R2");
  assert.equal(classify("unknown-class: text", ledger).problem, "R2");
  assert.equal(classify("other-os: Windows only", ledger).skipClass, "other-os");

  const windows = checkSkips({ records: [skip("wired", "native-fixture: fixture not set")], ledger, platform: "win32", fullRun: false });
  assert.match(windows.problems.join("\n"), /^R3: test\/a\.test\.mjs > wired: native-fixture skip on Windows/m);
  assert.deepEqual(checkSkips({ records: [skip("wired", "native-fixture: fixture not set")], ledger, platform: "linux", fullRun: false }).problems, []);

  const records = [skip("kept", "other-os: Windows only"), skip("new", "other-os: Windows only"), skip("mine", "opt-in: set X")];
  assert.deepEqual(checkSkips({ records, ledger, platform: "linux", fullRun: false }).problems, [], "selected files check R1-R3 only");
  const full = checkSkips({ records, ledger, platform: "linux", fullRun: true });
  assert.equal(full.problems.length, 1);
  assert.match(full.problems[0], /^R4: linux "other-os" skips: 2 now, 2 pinned\./);
  assert.match(full.problems[0], /now skipped: test\/a\.test\.mjs > new/);
  assert.match(full.problems[0], /no longer skipped: test\/a\.test\.mjs > slept/);
  assert.deepEqual(full.summary, ["opt-in 1", "other-os 2"]);
  assert.match(checkSkips({ records, ledger, platform: "darwin", fullRun: true }).problems.join("\n"), /no entry for darwin/);

  const unsupplied = ["LODE_AGENT_TEST_OWNER_CRASH_FIXTURE", "HEAD_AGENT_TEST_OWNER_CRASH_FIXTURE"];
  const excused = checkSkips({
    records: [
      skip("crash", "native-fixture: LODE_AGENT_TEST_OWNER_CRASH_FIXTURE not set"),
      skip("wired", "native-fixture: LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT not set"),
    ],
    ledger: { ...ledger, skips: { win32: {} } },
    platform: "win32",
    fullRun: true,
    unsupplied,
  });
  assert.equal(excused.problems.length, 2, "only the announced fixture is excused, from R3 and R4");
  assert.match(excused.problems[0], /^R3: test\/a\.test\.mjs > wired:/);
  assert.match(excused.problems[1], /^R4: win32 "native-fixture" skips: 1 now, 0 pinned\.\n {2}now skipped: test\/a\.test\.mjs > wired$/);
  assert.deepEqual(excused.summary, ["native-fixture 1", "native-fixture (not supplied) 1"]);

  const bounded = { ...ledger, classes: { ...ledger.classes, "opt-in": { pinned: false, bounded: true, meaning: "x" } } };
  bounded.skips = { linux: { "other-os": ["test/a.test.mjs > kept"], "opt-in": ["test/a.test.mjs > listed", "test/a.test.mjs > ran"] } };
  const optIn = [skip("kept", "other-os: Windows only"), skip("listed", "opt-in: set X")];
  assert.deepEqual(checkSkips({ records: optIn, ledger: bounded, platform: "linux", fullRun: true }).problems, [], "a listed opt-in test may run or skip");
  const asleep = checkSkips({ records: [...optIn, skip("woken", "opt-in: set NEVER_SET")], ledger: bounded, platform: "linux", fullRun: true });
  assert.deepEqual(asleep.problems, ['R4: linux "opt-in" skips not on the ledger\'s list (an upper bound): 1.\n  now skipped: test/a.test.mjs > woken']);
  assert.deepEqual(asleep.observed["opt-in"], ["test/a.test.mjs > listed", "test/a.test.mjs > woken"]);
  assert.deepEqual(checkSkips({ records: [skip("woken", "opt-in: set NEVER_SET")], ledger: bounded, platform: "linux", fullRun: false }).problems, []);
  // A multiset, like the pinned classes: a test listed once that skips twice (a loop, a repeated name) is one too many.
  const twice = checkSkips({ records: [...optIn, skip("listed", "opt-in: set X")], ledger: bounded, platform: "linux", fullRun: true });
  assert.deepEqual(twice.problems, ['R4: linux "opt-in" skips not on the ledger\'s list (an upper bound): 1.\n  now skipped: test/a.test.mjs > listed']);

  const todo = checkSkips({ records: [{ kind: "todo", file: "test/a.test.mjs", test: "later", passed: true }], ledger, platform: "linux", fullRun: false });
  assert.match(todo.problems.join("\n"), /^T: test\/a\.test\.mjs > later: todo test/);

  const limited = [skip("linked", "host-limit: cannot create a directory link here"), skip("kept", "other-os: Windows only")];
  for (const fullRun of [false, true]) {
    const local = checkSkips({ records: limited, ledger, platform: "linux", fullRun, ci: false });
    assert.deepEqual(local.problems.filter((problem) => problem.startsWith("H:")), [], "outside CI a host-limit skip is only counted");
    assert.ok(local.summary.includes("host-limit 1"));
    const inCi = checkSkips({ records: limited, ledger, platform: "linux", fullRun, ci: true });
    assert.deepEqual(
      inCi.problems.filter((problem) => problem.startsWith("H:")),
      ["H: test/a.test.mjs > linked: host-limit skip in CI; the CI runner must give this test what it needs: host-limit: cannot create a directory link here"],
      `in CI a host-limit skip fails (${fullRun ? "full run" : "selected files"})`,
    );
    assert.ok(inCi.summary.includes("host-limit 1"), "it is still counted");
  }
  assert.equal(runsInCi({ CI: "true" }), true);
  for (const env of [{}, { CI: "false" }, { CI: "" }, { GITHUB_ACTIONS: "true" }]) assert.equal(runsInCi(env), false, JSON.stringify(env));
});

function runnerSandbox(t) {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lode-test-runner-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  fs.cpSync(path.join(root, "scripts"), path.join(sandbox, "scripts"), { recursive: true });
  fs.cpSync(path.join(root, "compat"), path.join(sandbox, "compat"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ version: "0.3.0-beta.80", type: "module" }));
  fs.mkdirSync(path.join(sandbox, "test", "fixtures"), { recursive: true });
  fs.copyFileSync(path.join(root, "test", "fixtures", "skip-ledger.json"), path.join(sandbox, "test", "fixtures", "skip-ledger.json"));
  // The runner only checks that a fixture is present; these tests never start it.
  const fixture = path.join(sandbox, "fixture");
  const binaryDir = path.join(fixture, "dist", `${goos}-${process.arch}`);
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.writeFileSync(path.join(binaryDir, supervisorName), "stand-in");
  fs.writeFileSync(path.join(binaryDir, "SUPERVISOR-MANIFEST.json"), "{}");
  const temp = path.join(sandbox, "tmp");
  fs.mkdirSync(temp);
  const environment = { ...process.env, LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT: fixture, TMP: temp, TEMP: temp, TMPDIR: temp };
  for (const name of TEST_FIXTURE_NAMES) delete environment[name];
  // The same result on a developer machine and in CI: a test that wants CI sets it itself.
  for (const name of Object.keys(environment).filter((key) => key.toUpperCase() === "CI")) delete environment[name];
  if (process.platform === "win32") {
    // Ready stand-ins, so the runner does not build the Windows test fixtures from sources the sandbox lacks.
    const ownerCrash = path.join(sandbox, "owned-worker-crash.exe");
    fs.writeFileSync(ownerCrash, "stand-in");
    Object.assign(environment, { LODE_AGENT_TEST_OWNER_CRASH_FIXTURE: ownerCrash, LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT: fixture });
  }
  delete environment.LODE_AGENT_KEEP_TEST_TMP;
  delete environment.HEAD_AGENT_KEEP_TEST_TMP;
  delete environment.LODE_AGENT_TEST_TIMEOUT_MS;
  const write = (name, source) => fs.writeFileSync(path.join(sandbox, "test", name), source);
  const run = (args, extra = {}) =>
    spawnSync(process.execPath, ["scripts/run-tests.mjs", ...args], {
      cwd: sandbox,
      // Windows environment names ignore case: an override replaces every spelling.
      env: {
        ...Object.fromEntries(Object.entries(environment).filter(([key]) => !Object.keys(extra).some((name) => name.toUpperCase() === key.toUpperCase()))),
        ...extra,
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    });
  return { sandbox, fixture, temp, environment, write, run };
}

test("the runner gives the suite a fresh profile, drops inherited state roots and the Claude messaging endpoint, and exports both fixture names", (t) => {
  const box = runnerSandbox(t);
  const capture = path.join(box.sandbox, "environment.json");
  box.write(
    "environment.test.mjs",
    `import fs from "node:fs"; import test from "node:test";
test("captures the environment", () => { fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.env)); });
`,
  );
  const caller = path.join(box.sandbox, "caller-profile");
  const callerProfile = Object.fromEntries(PROFILE_NAMES.map((name) => [name, path.join(caller, name)]));
  const result = box.run(["test/environment.test.mjs"], {
    ...callerProfile,
    LODE_AGENT_OPERATIONAL_STATE_ROOT: path.join(caller, "state"),
    HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(caller, "state"),
    CLAUDE_CODE_MESSAGING_SOCKET: path.join(caller, "messaging.sock"),
    CLAUDE_CODE_MESSAGING_TOKEN: "caller-token-never-inherited",
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const seen = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(seen.LODE_AGENT_OPERATIONAL_STATE_ROOT, undefined);
  assert.equal(seen.HEAD_AGENT_OPERATIONAL_STATE_ROOT, undefined);
  assert.equal(seen.CLAUDE_CODE_MESSAGING_SOCKET, undefined, "the caller's Claude messaging endpoint is not inherited");
  assert.equal(seen.CLAUDE_CODE_MESSAGING_TOKEN, undefined, "the caller's Claude messaging token is not inherited");
  const profileRoot = path.dirname(seen.HOME);
  assert.ok(path.basename(profileRoot).startsWith("lode-test-run-"), seen.HOME);
  assert.equal(path.dirname(profileRoot), fs.realpathSync.native(box.temp));
  for (const name of PROFILE_NAMES) {
    assert.ok(seen[name].startsWith(seen.HOME), `${name} lies in the temporary profile: ${seen[name]}`);
    assert.ok(!seen[name].startsWith(caller), `${name} is not the caller's`);
  }
  assert.equal(seen.USERPROFILE, seen.HOME);
  for (const name of FIXTURE_NAMES) assert.equal(seen[name], box.fixture, name);
  for (const name of TEST_FIXTURE_NAMES) {
    if (process.platform !== "win32") assert.equal(seen[name], undefined, name);
    else assert.equal(seen[name], box.environment[name.replace(/^HEAD_AGENT_/, "LODE_AGENT_")], `${name} is exported under both names`);
  }
  assert.equal(fs.existsSync(profileRoot), false, "the temporary profile is removed at the end");

  const kept = box.run(["test/environment.test.mjs"], { LODE_AGENT_KEEP_TEST_TMP: "1" });
  assert.equal(kept.status, 0, kept.stderr + kept.stdout);
  const keptRoot = path.dirname(JSON.parse(fs.readFileSync(capture, "utf8")).HOME);
  assert.ok(fs.existsSync(keptRoot), "the keep-temp variable keeps the profile");
  assert.match(kept.stderr, /Kept the test profile at /);
});

test("the runner fails a run on a reasonless or unclassified skip and names a timed-out test", (t) => {
  const box = runnerSandbox(t);
  box.write("classified.test.mjs", 'import test from "node:test";\ntest("classified", { skip: "other-os: elsewhere only" }, () => {});\n');
  const classified = box.run(["test/classified.test.mjs"]);
  assert.equal(classified.status, 0, classified.stderr + classified.stdout);
  assert.match(classified.stdout, /# skipped by class: other-os 1/);

  // Assembled so that the static check above does not see a bare skip in this file.
  box.write("bare.test.mjs", `import test from "node:test";\ntest("bare", (t) => t.${"skip"}());\n`);
  const bare = box.run(["test/bare.test.mjs"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /R1: test\/bare\.test\.mjs > bare: skip has no reason/);

  box.write("unclassified.test.mjs", 'import test from "node:test";\ntest("unclassified", { skip: "just because" }, () => {});\n');
  const unclassified = box.run(["test/unclassified.test.mjs"]);
  assert.equal(unclassified.status, 1);
  assert.match(unclassified.stderr, /R2: test\/unclassified\.test\.mjs > unclassified: reason does not start with/);

  box.write(
    "slow.test.mjs",
    'import test from "node:test";\ntest("sleeps past the limit", async () => { await new Promise((resolve) => setTimeout(resolve, 5_000)); });\n',
  );
  const slow = box.run(["test/slow.test.mjs"], { LODE_AGENT_TEST_TIMEOUT_MS: "500" });
  assert.notEqual(slow.status, 0);
  assert.match(slow.stdout, /test timed out after 500ms/);
  assert.match(slow.stderr, /Timed out after 500 ms: test\/slow\.test\.mjs > sleeps past the limit/);
  assert.equal(box.run(["test/slow.test.mjs"], { LODE_AGENT_TEST_TIMEOUT_MS: "soon" }).status, 2);

  box.write(
    "hung.test.mjs",
    `import { before, describe, test } from "node:test";
const sleep = () => new Promise((resolve) => setTimeout(resolve, 5_000));
describe("suite", () => { before(sleep); test("inner", () => {}); });
test("parent", async (t) => { await t.test("child", sleep); });
`,
  );
  const hung = box.run(["test/hung.test.mjs"], { LODE_AGENT_TEST_TIMEOUT_MS: "500" });
  assert.notEqual(hung.status, 0);
  assert.match(hung.stderr, /Timed out after 500 ms: test\/hung\.test\.mjs > suite \(failed running before hook: test timed out after 500ms\)/);
  assert.match(hung.stderr, /Timed out after 500 ms: test\/hung\.test\.mjs > parent\n {2}cancelled with it: test\/hung\.test\.mjs > parent > child/);

  box.write("todo.test.mjs", 'import test from "node:test";\ntest("later", { todo: "not yet" }, () => { throw new Error("broken"); });\n');
  const todo = box.run(["test/todo.test.mjs"]);
  assert.equal(todo.status, 1, "node passes a failing todo test; the runner does not");
  assert.match(todo.stderr, /T: test\/todo\.test\.mjs > later: todo test/);
});

test("in CI the runner fails a run on a host-limit skip and names it; outside CI it only counts it", (t) => {
  const box = runnerSandbox(t);
  box.write("limited.test.mjs", 'import test from "node:test";\ntest("linked", { skip: "host-limit: cannot create a directory link here" }, () => {});\n');
  const local = box.run(["test/limited.test.mjs"]);
  assert.equal(local.status, 0, local.stderr + local.stdout);
  assert.match(local.stdout, /# skipped by class: host-limit 1/);
  assert.doesNotMatch(local.stderr, /H: /);

  const ci = box.run(["test/limited.test.mjs"], { CI: "true" });
  assert.equal(ci.status, 1, ci.stderr + ci.stdout);
  assert.match(ci.stdout, /# skipped by class: host-limit 1/);
  assert.match(ci.stderr, /Skip ledger check failed \(selected files, R1-R3, T and H, in CI\):/);
  assert.match(
    ci.stderr,
    /H: test\/limited\.test\.mjs > linked: host-limit skip in CI; the CI runner must give this test what it needs: host-limit: cannot create a directory link here/,
  );
});

test("without Go on Windows the runner names the test fixtures it cannot supply and excuses only skips that name them", (t) => {
  if (process.platform !== "win32") return t.skip("other-os: the owner-crash and terminal-hold test fixtures exist only on Windows");
  const box = runnerSandbox(t);
  box.write(
    "unsupplied.test.mjs",
    `import test from "node:test";
test("owner crash", { skip: "native-fixture: LODE_AGENT_TEST_OWNER_CRASH_FIXTURE not set" }, () => {});
test("terminal hold", { skip: "native-fixture: LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT not set" }, () => {});
`,
  );
  box.write(
    "wired.test.mjs",
    'import test from "node:test";\ntest("file effect", { skip: "native-fixture: LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT not set" }, () => {});\n',
  );
  const noGo = { PATH: path.dirname(process.execPath), LODE_AGENT_TEST_OWNER_CRASH_FIXTURE: "", LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT: "" };
  const excused = box.run(["test/unsupplied.test.mjs"], noGo);
  assert.equal(excused.status, 0, excused.stderr + excused.stdout);
  assert.match(
    excused.stderr,
    /Go is not available and these Windows test fixtures were not supplied: LODE_AGENT_TEST_OWNER_CRASH_FIXTURE, HEAD_AGENT_TEST_OWNER_CRASH_FIXTURE, LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT, HEAD_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT\./,
  );
  assert.match(excused.stdout, /# skipped by class: native-fixture \(not supplied\) 2/);
  const wired = box.run(["test/wired.test.mjs"], noGo);
  assert.equal(wired.status, 1);
  assert.match(wired.stderr, /R3: test\/wired\.test\.mjs > file effect: native-fixture skip on Windows/);
});

test("a full run compares pinned skips with the ledger and prints the tests that moved", (t) => {
  const box = runnerSandbox(t);
  box.write("only.test.mjs", 'import test from "node:test";\ntest("sleeper", { skip: "other-os: elsewhere only" }, () => {});\n');
  const ledgerFile = path.join(box.sandbox, "test", "fixtures", "skip-ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  ledger.skips = { [process.platform]: { "other-os": ["test/only.test.mjs > sleeper"] } };
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  const same = box.run([]);
  assert.equal(same.status, 0, same.stderr + same.stdout);

  ledger.skips = { [process.platform]: { "other-os": ["test/only.test.mjs > renamed"] } };
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  const moved = box.run([]);
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /now skipped: test\/only\.test\.mjs > sleeper/);
  assert.match(moved.stderr, /no longer skipped: test\/only\.test\.mjs > renamed/);
  assert.match(moved.stderr, /Listed skips observed in this run/);
});

test("automatic fixture rebuilds changed Go sources while explicit CI fixture remains caller-owned", (t) => {
  const probe = spawnSync("go", ["version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (probe.error?.code === "ENOENT") return t.skip("opt-in: Go toolchain (go) not on PATH; the Go-equipped CI jobs run this regression.");
  assert.equal(probe.status, 0, probe.stderr);
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lode-test-fixture-source-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  fs.mkdirSync(path.join(sandbox, "scripts"));
  fs.copyFileSync(path.join(root, "scripts/run-tests.mjs"), path.join(sandbox, "scripts/run-tests.mjs"));
  fs.cpSync(path.join(root, "scripts"), path.join(sandbox, "scripts"), { recursive: true });
  fs.cpSync(path.join(root, "compat"), path.join(sandbox, "compat"), { recursive: true });
  fs.cpSync(path.join(root, "native/lode-agent-worker"), path.join(sandbox, "native/lode-agent-worker"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ version: "0.3.0-beta.80", type: "module" }));
  fs.mkdirSync(path.join(sandbox, "test", "fixtures"), { recursive: true });
  fs.copyFileSync(path.join(root, "test", "fixtures", "skip-ledger.json"), path.join(sandbox, "test", "fixtures", "skip-ledger.json"));
  fs.writeFileSync(path.join(sandbox, "test/synthetic.test.mjs"), 'import test from "node:test"; test("fixture admitted", () => {});\n');
  const source = path.join(sandbox, "native/lode-agent-worker/cmd/lode-agent-supervisor");
  const input = path.join(source, "main.go"),
    originalSource = fs.readFileSync(input, "utf8");
  const env = { ...process.env };
  delete env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT;
  delete env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT;
  for (const name of TEST_FIXTURE_NAMES) delete env[name];
  if (process.platform === "win32") {
    // Ready stand-ins: the sandbox has no test helpers to build them from.
    const ownerCrash = path.join(sandbox, "owned-worker-crash.exe");
    const terminalHold = path.join(sandbox, "terminal-hold", "dist", "windows-" + process.arch);
    fs.writeFileSync(ownerCrash, "stand-in");
    fs.mkdirSync(terminalHold, { recursive: true });
    fs.writeFileSync(path.join(terminalHold, "lode-agent-supervisor.exe"), "stand-in");
    fs.writeFileSync(path.join(terminalHold, "SUPERVISOR-MANIFEST.json"), "{}");
    Object.assign(env, { LODE_AGENT_TEST_OWNER_CRASH_FIXTURE: ownerCrash, LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT: path.join(sandbox, "terminal-hold") });
  }
  const run = (environment) => {
    t.diagnostic(
      JSON.stringify({
        event: "planned-synthetic-fixture-run",
        command: process.execPath,
        args: ["scripts/run-tests.mjs", "test/synthetic.test.mjs"],
        cwd: sandbox,
        ports: [],
        windowsHide: true,
      }),
    );
    const result = spawnSync(process.execPath, ["scripts/run-tests.mjs", "test/synthetic.test.mjs"], {
      cwd: sandbox,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    });
    t.diagnostic(JSON.stringify({ event: "synthetic-fixture-run-exited", pid: result.pid, status: result.status, cwd: sandbox, ports: [] }));
    if (result.status !== 0) t.diagnostic((result.stderr + result.stdout).slice(0, 12000));
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result;
  };
  run(env);
  const binary = path.join(
    sandbox,
    ".cache/lode-supervisor-fixture/dist",
    (process.platform === "win32" ? "windows" : process.platform) + "-" + process.arch,
    "lode-agent-supervisor" + (process.platform === "win32" ? ".exe" : ""),
  );
  const digest = () => crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  const first = digest();
  fs.writeFileSync(input, originalSource + '\nfunc init() { version += "-fixture-source-changed" }\n');
  run(env);
  assert.notEqual(digest(), first);
  const second = digest();
  fs.writeFileSync(input, "invalid Go source");
  run({ ...env, LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT: path.join(sandbox, ".cache/lode-supervisor-fixture") });
  assert.equal(digest(), second);
});

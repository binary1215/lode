import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import { createProcessSupervisorManifest } from "./lib/runtime/runtime-process-supervisor.mjs";
import { atomicWriteArtifact } from "./lib/storage/artifact-storage.mjs";
import { checkSkips, readLedger, readRecords, runsInCi } from "./test-skip-ledger.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const goos = process.platform === "win32" ? "windows" : process.platform;
const executableName = process.platform === "win32" ? "lode-agent-supervisor.exe" : "lode-agent-supervisor";
// About five times the slowest measured test (103 s on Windows CI), and never below ten minutes.
const DEFAULT_TEST_TIMEOUT_MS = 600_000;
const keepTemp = process.env.LODE_AGENT_KEEP_TEST_TMP === "1" || process.env.HEAD_AGENT_KEEP_TEST_TMP === "1";

function ready(directory) {
  if (!directory) return false;
  const binary = path.join(directory, "dist", `${goos}-${process.arch}`, executableName);
  const manifest = path.join(path.dirname(binary), "SUPERVISOR-MANIFEST.json");
  try {
    return fs.statSync(binary).isFile() && fs.statSync(manifest).isFile();
  } catch {
    return false;
  }
}

function buildFixture() {
  const directory = path.join(root, ".cache", "lode-supervisor-fixture");
  const binaryDir = path.join(directory, "dist", `${goos}-${process.arch}`);
  const binary = path.join(binaryDir, executableName);
  const manifest = path.join(binaryDir, "SUPERVISOR-MANIFEST.json");
  // Always let Go validate its incremental build cache against current sources,
  // toolchain and flags. File existence cannot establish fixture freshness.
  // The build keeps the caller's real environment: Go's cache lives in the profile.
  fs.mkdirSync(binaryDir, { recursive: true });
  const go = spawnSync(
    "go",
    ["build", "-trimpath", "-buildvcs=false", `-ldflags=-s -w -X main.version=${version} -X main.commit=local`, "-o", binary, "./cmd/lode-agent-supervisor"],
    {
      cwd: path.join(root, "native", "lode-agent-worker"),
      env: { ...process.env, CGO_ENABLED: "0" },
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    },
  );
  if (go.error || go.status !== 0) {
    console.error(
      "npm test builds the process-supervisor fixture itself. Install Go and retry, or set LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT to a built fixture. On Windows a test that skips for want of this fixture fails the run.",
    );
    process.exit(go.status || 1);
  }
  const generated = createProcessSupervisorManifest({ platform: process.platform, arch: process.arch, binaryFile: binary, manifestDirectory: binaryDir });
  atomicWriteArtifact(manifest, JSON.stringify(generated, null, 2) + "\n");
  return directory;
}

let goProbe;
function goAvailable() {
  goProbe ??= spawnSync("go", ["version"], { stdio: "ignore", shell: false, windowsHide: true });
  return !goProbe.error && goProbe.status === 0;
}

function goBuild(args, cwd, what) {
  const go = spawnSync("go", args, { cwd, env: { ...process.env, CGO_ENABLED: "0" }, stdio: "inherit", shell: false, windowsHide: true });
  if (go.error || go.status !== 0) throw Object.assign(new Error(`npm test could not build ${what}.`), { exitCode: go.status || 1 });
}

function isFile(file) {
  try {
    return Boolean(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Windows-only test fixtures, each under its LODE_AGENT_ and HEAD_AGENT_ name.
// A ready caller-supplied one is used as given; otherwise the runner builds it
// into this run's temporary folder when Go is available. Without Go, the
// runner names the ones it could not supply, and only skips whose reason names
// them are excused from R3 and R4.
function windowsTestFixtures(run) {
  if (process.platform !== "win32") return { exported: {}, unsupplied: [] };
  const exported = {};
  const unsupplied = [];
  const fixtures = [
    {
      names: ["LODE_AGENT_TEST_OWNER_CRASH_FIXTURE", "HEAD_AGENT_TEST_OWNER_CRASH_FIXTURE"],
      ready: isFile,
      build() {
        const binary = path.join(run, "fixtures", "owned-worker-crash.exe");
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        goBuild(["build", "-trimpath", "-o", binary, "./test/helpers/owned-worker-crash-windows.go"], root, "the owner-crash test helper");
        return binary;
      },
    },
    {
      names: ["LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT", "HEAD_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT"],
      ready,
      build() {
        // A test binary that stands in for the supervisor: kept apart from the
        // normal fixture root and from everything a release packages.
        const directory = path.join(run, "fixtures", "terminal-hold");
        const binaryDir = path.join(directory, "dist", `${goos}-${process.arch}`);
        const binary = path.join(binaryDir, executableName);
        fs.mkdirSync(binaryDir, { recursive: true });
        goBuild(
          ["test", "-c", "-trimpath", "-o", binary, "./cmd/lode-agent-supervisor"],
          path.join(root, "native", "lode-agent-worker"),
          "the terminal-hold test supervisor",
        );
        const generated = createProcessSupervisorManifest({ platform: process.platform, arch: process.arch, binaryFile: binary, manifestDirectory: binaryDir });
        atomicWriteArtifact(path.join(binaryDir, "SUPERVISOR-MANIFEST.json"), JSON.stringify(generated, null, 2) + "\n");
        return directory;
      },
    },
  ];
  for (const fixture of fixtures) {
    const value = fixture.names.map((name) => process.env[name]).find((candidate) => fixture.ready(candidate)) ?? (goAvailable() ? fixture.build() : null);
    if (value) for (const name of fixture.names) exported[name] = value;
    else unsupplied.push(...fixture.names);
  }
  return { exported, unsupplied };
}

function testTimeout() {
  const raw = process.env.LODE_AGENT_TEST_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TEST_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.error(`LODE_AGENT_TEST_TIMEOUT_MS must be a positive whole number of milliseconds, not ${JSON.stringify(raw)}.`);
    process.exit(2);
  }
  return value;
}

// A fresh profile for the suite, so no test reads or writes the caller's own
// home, Host configuration or operational state.
function temporaryProfile(run) {
  const home = path.join(run, "home");
  const profile = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
  };
  for (const directory of new Set(Object.values(profile))) fs.mkdirSync(directory, { recursive: true });
  return profile;
}

const configuredFixture = [process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT, process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT].find(ready);
const fixture = configuredFixture ?? buildFixture();
const timeout = testTimeout();
const patterns = process.argv.slice(2);
const fullRun = patterns.length === 0;
const files = fullRun
  ? fs
      .readdirSync(path.join(root, "test"))
      .filter((name) => name.endsWith(".test.mjs"))
      .sort()
      .map((name) => path.join("test", name))
  : patterns;
const temp = fs.realpathSync.native(os.tmpdir());
const run = fs.mkdtempSync(path.join(temp, "lode-test-run-"));
const report = path.join(run, "skip-ledger.jsonl");
let testFixtures;
try {
  testFixtures = windowsTestFixtures(run);
} catch (error) {
  console.error(error.message);
  fs.rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(error.exitCode ?? 1);
}
if (testFixtures.unsupplied.length) {
  console.error(
    `Go is not available and these Windows test fixtures were not supplied: ${testFixtures.unsupplied.join(", ")}. Tests that need them skip, and only those skips are excused from the skip ledger check.`,
  );
}
const env = {
  ...process.env,
  ...temporaryProfile(run),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  TMPDIR: temp,
  TEMP: temp,
  TMP: temp,
  // The file-effect bridge is served by the supervisor binary itself.
  LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT: fixture,
  HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT: fixture,
  LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT: fixture,
  HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT: fixture,
  ...testFixtures.exported,
};
for (const name of testFixtures.unsupplied) delete env[name];
// Tests set their own operational roots; an inherited one makes their fixtures conflict.
delete env.LODE_AGENT_OPERATIONAL_STATE_ROOT;
delete env.HEAD_AGENT_OPERATIONAL_STATE_ROOT;
// A Claude session's shell carries its live messaging endpoint; the suite must not reach it.
delete env.CLAUDE_CODE_MESSAGING_SOCKET;
delete env.CLAUDE_CODE_MESSAGING_TOKEN;

const child = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-reporter=tap",
    "--test-reporter-destination=stdout",
    `--test-reporter=${pathToFileURL(path.join(root, "scripts", "test-skip-ledger.mjs")).href}`,
    `--test-reporter-destination=${report}`,
    "--test-isolation=none",
    "--test-concurrency=1",
    `--test-timeout=${timeout}`,
    ...files,
  ],
  { cwd: root, env, stdio: "inherit", shell: false, windowsHide: true },
);

const records = readRecords(report);
const ci = runsInCi();
const { problems, summary, observed } = checkSkips({ records, ledger: readLedger(), fullRun, unsupplied: testFixtures.unsupplied, ci });
const timedOut = records.filter((record) => record.kind === "timeout");
const cancelled = records.filter((record) => record.kind === "cancelled");
console.log(`# skipped by class: ${summary.join(", ") || "none"}`);
for (const record of timedOut) {
  const detail = /hook/.test(record.message) ? ` (${record.message})` : "";
  console.error(`Timed out after ${timeout} ms: ${record.file} > ${record.test}${detail}`);
  // Node cancels the subtests still running under it; name them, since the hang is in one of them.
  for (const child of cancelled.filter((entry) => entry.file === record.file && entry.test.startsWith(`${record.test} > `))) {
    console.error(`  cancelled with it: ${child.file} > ${child.test}`);
  }
}
if (problems.length) {
  console.error(`Skip ledger check failed (${fullRun ? "full run, R1-R4" : "selected files, R1-R3"}, T${ci ? " and H, in CI" : ""}):`);
  for (const problem of problems) console.error(problem);
  if (problems.some((problem) => problem.startsWith("R4:"))) {
    console.error(
      `Listed skips observed in this run for "${process.platform}" (test/fixtures/skip-ledger.json, skips.${process.platform}; a bounded class's list is an upper bound, so add its new names instead of replacing the list):`,
    );
    console.error(JSON.stringify(observed, null, 2));
  }
}
if (keepTemp) console.error(`Kept the test profile at ${run}`);
else {
  try {
    fs.rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.error(`Could not remove the test profile ${run}: ${error.code ?? error.message}`);
  }
}
if (child.error) console.error(child.error.message);
process.exit(child.status || (child.error || child.signal ? 1 : 0) || (problems.length ? 1 : 0));

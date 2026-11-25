import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import { createProcessSupervisorManifest } from "./lib/runtime/runtime-process-supervisor.mjs";
import { atomicWriteArtifact } from "./lib/storage/artifact-storage.mjs";
import { checkSkips, readLedger, readRecords } from "./test-skip-ledger.mjs";

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
};
// Tests set their own operational roots; an inherited one makes their fixtures conflict.
delete env.LODE_AGENT_OPERATIONAL_STATE_ROOT;
delete env.HEAD_AGENT_OPERATIONAL_STATE_ROOT;

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
const { problems, summary, observed } = checkSkips({ records, ledger: readLedger(), fullRun });
const timedOut = records.filter((record) => record.kind === "timeout");
console.log(`# skipped by class: ${summary.join(", ") || "none"}`);
for (const record of timedOut) console.error(`Timed out after ${timeout} ms: ${record.file} > ${record.test}`);
if (problems.length) {
  console.error(`Skip ledger check failed (${fullRun ? "full run, R1-R4" : "selected files, R1-R3"}):`);
  for (const problem of problems) console.error(problem);
  if (problems.some((problem) => problem.startsWith("R4:"))) {
    console.error(`Pinned skips observed in this run for "${process.platform}" (test/fixtures/skip-ledger.json, skips.${process.platform}):`);
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

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const goos = process.platform === "win32" ? "windows" : process.platform;
const executableName = process.platform === "win32" ? "lode-agent-supervisor.exe" : "lode-agent-supervisor";

function ready(directory) {
  if (!directory) return false;
  const binary = path.join(directory, "dist", `${goos}-${process.arch}`, executableName);
  const manifest = path.join(path.dirname(binary), "SUPERVISOR-MANIFEST.json");
  try { return fs.statSync(binary).isFile() && fs.statSync(manifest).isFile(); }
  catch { return false; }
}

function buildFixture() {
  const directory = path.join(root, ".cache", "lode-supervisor-fixture");
  const binaryDir = path.join(directory, "dist", `${goos}-${process.arch}`);
  const binary = path.join(binaryDir, executableName);
  const manifest = path.join(binaryDir, "SUPERVISOR-MANIFEST.json");
  if (ready(directory)) return directory;
  fs.mkdirSync(binaryDir, { recursive: true });
  const go = spawnSync("go", ["build", "-trimpath", "-buildvcs=false", `-ldflags=-s -w -X main.version=${version} -X main.commit=local`, "-o", binary, "./cmd/lode-agent-supervisor"], {
    cwd: path.join(root, "native", "lode-agent-worker"),
    env: { ...process.env, CGO_ENABLED: "0" },
    stdio: "inherit",
    shell: false,
  });
  if (go.error || go.status !== 0) {
    console.error("npm test builds the process-supervisor fixture itself. Install Go and retry. The suite does not skip those tests.");
    process.exit(go.status || 1);
  }
  const generated = spawnSync(process.execPath, [path.join(root, "scripts", "generate-process-supervisor-manifest.mjs"), "--platform", process.platform, "--arch", process.arch, "--binary", binary, "--output", manifest], {
    cwd: root, stdio: "inherit", shell: false,
  });
  if (generated.error || generated.status !== 0) process.exit(generated.status || 1);
  return directory;
}

const fixture = ready(process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT)
  ? process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT
  : buildFixture();
const patterns = process.argv.slice(2);
const files = patterns.length ? patterns : fs.readdirSync(path.join(root, "test")).filter(name => name.endsWith(".test.mjs")).sort().map(name => path.join("test", name));
const child = spawnSync(process.execPath, ["--test", "--test-isolation=none", "--test-concurrency=1", ...files], {
  cwd: root,
  env: { ...process.env, LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT: fixture },
  stdio: "inherit",
  shell: false,
});
process.exit(child.status ?? 1);

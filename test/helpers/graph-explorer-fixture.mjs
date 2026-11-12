import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fixture, sha, link } from "./session-work-linkage-fixture.mjs";
import { buildWorldModel } from "../../scripts/lib/world/world-model.mjs";
import { updateProjectDirection } from "../../scripts/lib/session/project-direction.mjs";
import { readGraphProject } from "../../scripts/lib/world/discovery-index.mjs";

// Shared synthetic input for source and actual-browser checks. No user records.
export async function explorerFixture(t, { history = false, adversarial = false } = {}) {
  const f = fixture(t, "Investigate relay; do not deploy");
  fs.mkdirSync(path.join(f.root, "src"));
  fs.writeFileSync(path.join(f.root, "src/main.mjs"), "import { relay } from './relay.mjs';\nexport function run(value) { return relay(value); }\n");
  fs.writeFileSync(path.join(f.root, "src/relay.mjs"), "export function relay(value) { return value; }\n");
  const label = "긴 한국어 목적: 입력 경로와 이전 판단을 보존하며 관련 코드 근거를 확인합니다. ".repeat(5);
  const attack = "</script><img src='https://example.invalid/pixel' onerror='globalThis.graphXss=1'><svg onload='globalThis.graphXss=1'>";
  updateProjectDirection({ root: f.root, input: { goal: adversarial ? `relay ${attack}` : label,
    constraints: ["Synthetic local evidence only"], cancelledActions: ["Do not deploy", "기존 기록을 삭제하지 말 것"] } });
  f.save({ summary: "Local investigation result", judgments: [{ assessment: "Inspect relay before editing", reason: "Keep exact prior rationale" }],
    pending: ["Check caller evidence"], unknowns: ["External outcome remains unverified"] });
  await buildWorldModel({ root: f.root });
  if (history) {
    fs.appendFileSync(path.join(f.root, "src/relay.mjs"), "\n// second retained revision\n");
    await buildWorldModel({ root: f.root });
  }
  return { ...f, projectId: readGraphProject(f.root).project.projectId, label, attack };
}

// Reuses the real Core work writer, World/code reader and local Git byte reader.
// Generated synthetic source history only; no provider, remote or user repository.
export async function codeHistoryExplorerFixture(t) {
  const f = fixture(t, "Synthetic code-history viewer verification; no external effects"), sourcePath = "src/nested/synthetic-long-path/긴-코드-경로/relay-implementation.mjs";
  updateProjectDirection({ root: f.root, input: { goal: "Synthetic code-history viewer fixture — not a real user project", constraints: ["Synthetic local source evidence only"], cancelledActions: ["No deployment or provider effects"] } });
  const beforeSource = "export function relay(value) {\n  const mode = 'before';\n  return value * 2;\n}\n\nexport function retainedHelper() { return 'same'; }\n\nexport function removedHelper() { return 'old'; }\n";
  const afterSource = beforeSource.replace("'before'", "'after'").replace("value * 2", "value * 3").replace("removedHelper() { return 'old'", "addedHelper() { return 'new'");
  const file = relative => path.join(f.root, relative);
  fs.mkdirSync(path.dirname(file(sourcePath)), { recursive: true });
  fs.writeFileSync(file(sourcePath), beforeSource);
  fs.writeFileSync(file("src/main.mjs"), `import { relay } from './${sourcePath.slice(4)}';\nexport function run(value) { return relay(value); }\n`);
  fs.writeFileSync(file("src/missing-later.mjs"), "export function missingLater() { return 'retained'; }\n");
  fs.writeFileSync(file("src/rename-before.mjs"), "export function renameCandidate() { return 'same bytes'; }\n");
  const hooks = path.join(f.base, "no-hooks"); fs.mkdirSync(hooks);
  const git = async args => {
    const all = ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false", "-c", "gc.auto=0", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", ...args];
    t.diagnostic(JSON.stringify({ event: "planned-fixture-git", command: "git", args: all, cwd: f.root, parent: process.pid, ports: [], windowsHide: true }));
    const child = spawn("git", all, { cwd: f.root, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
    t.diagnostic(JSON.stringify({ event: "fixture-git-started", pid: child.pid, parent: process.pid, at: new Date().toISOString(), birthBasis: "spawn observation; exact child handle retained, outer ledger samples OS birth", cwd: f.root, ports: [] }));
    let stdout = "", stderr = "", failure;
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    const timer = setTimeout(() => { failure = Error("Synthetic Git timed out"); child.kill("SIGTERM"); }, 15000);
    const outcome = await new Promise(resolve => { child.once("error", error => { failure = error; }); child.once("close", code => resolve(code)); }).finally(() => clearTimeout(timer));
    t.diagnostic(JSON.stringify({ event: "fixture-git-closed", pid: child.pid, parent: process.pid, code: outcome, at: new Date().toISOString(), cwd: f.root, ports: [] }));
    if (failure) throw failure; assert.equal(outcome, 0, stderr); return stdout.trim();
  };
  await git(["init", "--quiet"]); await git(["add", "--", "src"]); await git(["commit", "--quiet", "-m", "Synthetic source baseline, not product repository work"]);
  const baselineCommit = await git(["rev-parse", "HEAD"]);
  const saved = f.save({ summary: "Synthetic source citation before local edits; no fulfillment or deployment claim", references: [
    { kind: "source", path: sourcePath, digest: sha(beforeSource) },
    { kind: "source", path: "src/missing-later.mjs", digest: sha(fs.readFileSync(file("src/missing-later.mjs"))) },
    { kind: "source", path: "src/rename-before.mjs", digest: sha(fs.readFileSync(file("src/rename-before.mjs"))) }
  ] });
  await git(["mv", "--", "src/rename-before.mjs", "src/rename-after.mjs"]);
  await git(["commit", "--quiet", "-m", "Synthetic exact-byte path move, not logical continuity"]);
  fs.unlinkSync(file("src/missing-later.mjs")); // Exact generated fixture path only; not user data.
  fs.writeFileSync(file(sourcePath), afterSource);
  f.save({ summary: "Synthetic current source citation; not a request boundary or acceptance", workLink: link(saved), references: [{ kind: "source", path: sourcePath, digest: sha(afterSource) }] });
  await buildWorldModel({ root: f.root });
  return { ...f, projectId: readGraphProject(f.root).project.projectId, sourcePath, beforeSource, afterSource, baselineCommit, gitHead: await git(["rev-parse", "HEAD"]) };
}

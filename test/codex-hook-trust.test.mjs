import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatCodexHookTrust, inspectCodexHookTrust } from "../scripts/lib/codex-hook-trust.mjs";
import { formatProjectBootstrap, formatProjectStatus } from "../scripts/lib/cli-presentation.mjs";
import { initializeProject } from "../scripts/lib/lode-core.mjs";
import { inspectProjectExperience } from "../scripts/lib/project-bootstrap.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.join(os.tmpdir(), "한글 café (team)'s codex");

function home(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-codex-trust-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codex = path.join(root, ".codex");
  fs.mkdirSync(codex);
  if (body !== undefined) fs.writeFileSync(path.join(codex, "config.toml"), body);
  return { CODEX_HOME: codex, HOME: root, USERPROFILE: root };
}

test("absent, disabled, untrusted, and recorded Codex hook configs produce actionable guidance", t => {
  const absent = inspectCodexHookTrust({ projectRoot, pluginRoot, environment: home(t) });
  assert.equal(absent.status, "review-required");
  assert.match(absent.guidance, /\/hooks/);
  assert.match(absent.guidance, /Settings > Hooks/);
  assert.match(formatCodexHookTrust(absent), /not recorded/);

  const disabled = inspectCodexHookTrust({ projectRoot, pluginRoot, environment: home(t, "[features]\nhooks = false\n") });
  assert.equal(disabled.status, "disabled");

  const untrusted = inspectCodexHookTrust({ projectRoot, pluginRoot, environment: home(t, `[projects.${JSON.stringify(projectRoot)}]\ntrust_level = "untrusted"\n`) });
  assert.equal(untrusted.projectTrust, "untrusted");
  assert.equal(untrusted.status, "review-required", "Project-local trust does not disable user/plugin hooks.");

  const recorded = inspectCodexHookTrust({ projectRoot, pluginRoot, environment: home(t, `[projects.${JSON.stringify(projectRoot)}]\ntrust_level = "trusted"\n\n[hooks.state."${path.join(pluginRoot, "hooks", "codex.json").replaceAll("\\", "/")}:UserPromptSubmit:0:0"]\ntrusted_hash = "sha256:abc"\n`) });
  assert.equal(recorded.status, "recorded");
  assert.match(recorded.guidance, /does not prove/);

  const value = { codexHookTrust: absent, readiness: { core: { state: "ready" }, product: { state: "ready" }, context: { state: "repository-ready" }, recovery: { state: "no-current-checkpoint" } }, nextAction: { id: "work_directly", summary: "Continue." }, presentation: { mode: "normal" } };
  assert.match(formatProjectStatus(value, { doctor: true }), /\/hooks/);
  assert.match(formatProjectBootstrap({ ...value, projectAction: "initialized" }), /\/hooks/);
  assert.doesNotMatch(formatProjectStatus({ ...value, codexHookTrust: recorded }, { doctor: false }), /\/hooks/);
});

test("trust records never combine another hook, comments, or another state entry", t => {
  const exact = path.join(pluginRoot, "hooks", "codex.json").replaceAll("\\", "/");
  const cases = [
    '[hooks.state."/unrelated/hooks/codex.json:UserPromptSubmit:0:0"]\ntrusted_hash = "abc"\n# session-host-hook ' + exact,
    '[hooks.state.' + JSON.stringify(exact + ':UserPromptSubmit:0:0') + ']\nenabled = true\n[hooks.state."/other:Stop:0:0"]\ntrusted_hash = "abc"',
    '# [hooks.state.' + JSON.stringify(exact + ':UserPromptSubmit:0:0') + ']\n# trusted_hash = "abc"',
    '[hooks.state."lode-agent-core@lode-agent-plugin:hooks/codex.json:UserPromptSubmit:0:0"]\ntrusted_hash = "abc"',
    '[hooks.state.' + JSON.stringify(exact + ':UserPromptSubmit:0:0') + ']\ntrusted_hash = "abc"\nenabled = false',
  ];
  for (const body of cases) {
    const result = inspectCodexHookTrust({ projectRoot, pluginRoot, environment: home(t, body) });
    assert.notEqual(result.status, "recorded", body);
    assert.equal(result.ordinaryWorkBlocked, false);
  }
});


test("Codex trust is read and presented only for explicitly selected Codex runtimes", async t => {
  const environment = home(t, "[features]\nhooks = false\n"), config = path.join(environment.CODEX_HOME, "config.toml"), oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = environment.CODEX_HOME;
  const originalRead = fs.readFileSync; let reads = 0;
  t.mock.method(fs, "readFileSync", function(file, ...args) { if (typeof file === "string" && path.resolve(file) === config) reads++; return originalRead.call(this, file, ...args); });
  try {
    for (const runtimes of [null, ["claude"], ["opencode"], ["codex"], ["claude", "codex"]]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-trust-route-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      if (runtimes) initializeProject({ root, pluginRoot, runtimes });
      reads = 0; const experience = await inspectProjectExperience({ root });
      if (runtimes?.includes("codex")) { assert(reads > 0); assert.equal(experience.codexHookTrust.status, "disabled"); }
      else { assert.equal(reads, 0, "Unselected runtime must not read even a synthetic Codex config"); assert.equal(experience.codexHookTrust, undefined); assert.doesNotMatch(formatProjectStatus(experience, { doctor: true }), /Settings > Hooks|Codex hook/i); assert.doesNotMatch(formatProjectBootstrap({ ...experience, projectAction: "initialized" }), /Settings > Hooks|Codex hook/i); }
    }
  } finally { if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome; }
});

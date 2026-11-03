import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatCodexHookTrust, inspectCodexHookTrust } from "../scripts/lib/codex-hook-trust.mjs";
import { formatProjectBootstrap, formatProjectStatus } from "../scripts/lib/cli-presentation.mjs";

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

  const untrusted = inspectCodexHookTrust({ projectRoot, pluginRoot, environment: home(t, `[projects."${projectRoot}"]\ntrust_level = "untrusted"\n`) });
  assert.equal(untrusted.status, "project-untrusted");

  const recorded = inspectCodexHookTrust({ projectRoot, pluginRoot, environment: home(t, `[projects."${projectRoot}"]\ntrust_level = "trusted"\n\n[hooks.state."${path.join(pluginRoot, "hooks", "codex.json").replaceAll("\\", "/")}:UserPromptSubmit:0:0"]\ntrusted_hash = "sha256:abc"\n`) });
  assert.equal(recorded.status, "recorded");
  assert.match(recorded.guidance, /does not prove/);

  const value = { codexHookTrust: absent, readiness: { core: { state: "ready" }, product: { state: "ready" }, context: { state: "repository-ready" }, recovery: { state: "no-current-checkpoint" } }, nextAction: { id: "work_directly", summary: "Continue." }, presentation: { mode: "normal" } };
  assert.match(formatProjectStatus(value, { doctor: true }), /\/hooks/);
  assert.match(formatProjectBootstrap({ ...value, projectAction: "initialized" }), /\/hooks/);
  assert.doesNotMatch(formatProjectStatus({ ...value, codexHookTrust: recorded }, { doctor: false }), /\/hooks/);
});

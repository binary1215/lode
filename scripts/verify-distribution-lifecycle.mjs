#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  installDistribution,
  inspectDistribution,
  rollbackDistribution,
  uninstallDistribution,
} from "./lib/distribution-lifecycle.mjs";
import { resolveProjectStorage } from "./lib/project-storage-format.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceVersion = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")).version;
const upgradedVersion = `${sourceVersion}-e2e`;
const scratchRoot = path.join(sourceRoot, "tmp", `distribution-e2e-${process.pid}`);
const installRoot = path.join(scratchRoot, "user-data", "head-agent-core");
const binDirectory = path.join(scratchRoot, "user-home", ".local", "bin");
const upgradedSource = path.join(scratchRoot, "upgraded-source");
const projectRoot = path.join(scratchRoot, "project-without-git-or-graphdb");
const coreOnlyProjectRoot = path.join(scratchRoot, "core-only-project");
const evidenceResumeProjectRoot = path.join(scratchRoot, "project-awaiting-evidence");
const runtimeForbiddenMarkers = [
  ["ultimate", "goal"].join("_"),
  ["neo", "pick"].join(""),
];
const runtimeTextExtensions = new Set([".json", ".js", ".md", ".mjs", ".ps1", ".sh", ".txt"]);

function assertRuntimeSurfaceIsolated(root) {
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { stack.push(absolute); continue; }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      assert.equal(runtimeForbiddenMarkers.some((marker) => relative.toLowerCase().includes(marker)), false, relative);
      if (!runtimeTextExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const text = fs.readFileSync(absolute, "utf8").toLowerCase();
      assert.equal(runtimeForbiddenMarkers.some((marker) => text.includes(marker)), false, relative);
    }
  }
}

function copySourceFixture() {
  fs.mkdirSync(upgradedSource, { recursive: true });
  for (const entry of [".codex-plugin", ".mcp.json", "LICENSE", "README.md", "README.ko.md", "assets", "compat", "docs", "hooks", "native", "package.json", "scripts", "skills"]) {
    const source = path.join(sourceRoot, entry);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(upgradedSource, entry), {
      recursive: true,
      filter: (candidate) => !candidate.split(path.sep).some((part) => [".git", "dist", "node_modules", "test", "tmp", "__pycache__"].includes(part)),
    });
  }
  for (const relative of ["package.json", path.join(".codex-plugin", "plugin.json")]) {
    const file = path.join(upgradedSource, relative);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.version = upgradedVersion;
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  for (const relative of [".agent-work/review.md", "docs/.agent-work/review.md", "scripts/nested/.agent-work/result.json", "skills/.AGENT-WORK/review.md", "docs/.custom-source/keep.md"]) {
    const file = path.join(upgradedSource, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "work evidence fixture\n");
  }
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return JSON.parse(result.stdout);
}

async function verifyOpenCodeInstallation(expectedRoot) {
  const storage = resolveProjectStorage(projectRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, storage.directory, "generated/manifest.json"), "utf8"));
  assert.equal(fs.realpathSync(manifest.pluginRoot), fs.realpathSync(expectedRoot));
  assert.equal(manifest.packageVersion, JSON.parse(fs.readFileSync(path.join(expectedRoot, "package.json"), "utf8")).version);
  const file = path.join(projectRoot, "opencode.json"), original = fs.readFileSync(file, "utf8");
  // Model the pinned Host's env-before-JSON order with the optional env unset.
  const config = JSON.parse(original.replace(/\{env:LODE_PLUGIN_ROOT\}/g, ""));
  const { default: plugin } = await import(pathToFileURL(path.join(expectedRoot, "scripts/opencode-plugin.mjs")).href);
  const hooks = await plugin.server({ client: {}, project: { id: "synthetic-distribution-host" }, directory: projectRoot },
    { environment: { HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(scratchRoot, "operational") } });
  try { await hooks.config(config); } finally { await hooks.dispose(); }
  assert.deepEqual(config.mcp.lode.command, ["node", path.join(expectedRoot, "scripts/mcp-server.mjs")]);
  assert.equal(fs.readFileSync(file, "utf8"), original, "Runtime resolution must not rewrite the portable shared file.");
  assert.equal(original.includes(expectedRoot), false);
}

function runGlobal(args, identity = "lode", directory = binDirectory) {
  const command = process.platform === "win32" ? path.join(directory, `${identity}-agent.cmd`) : path.join(directory, `${identity}-agent`);
  const machineArgs = args.includes("--json") ? args : [...args, "--json"];
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${command}" ${machineArgs.map((item) => `"${item}"`).join(" ")}"`], { encoding: "utf8", shell: false, windowsHide: true, windowsVerbatimArguments: true })
    : spawnSync(command, machineArgs, { encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return JSON.parse(result.stdout);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function verifyHistoricalEntrypointRollback() {
  const root = path.join(scratchRoot, "owned-legacy-install");
  const directory = path.join(scratchRoot, "legacy-bin");
  // A bounded old-format installation fixture: this proves verified entrypoint
  // selection and immutable history, not execution of a historical HEAD engine.
  const files = new Map([
    ["package.json", `${JSON.stringify({ name: "@local/head-agent-core-plugin", version: "old-fixture" })}\n`],
    [".codex-plugin/plugin.json", `${JSON.stringify({ name: "head-agent-core", version: "old-fixture" })}\n`],
    ["scripts/head.mjs", 'process.stdout.write(JSON.stringify({ version: "old-fixture" }) + "\\n");\n'],
  ]);
  const identity = {
    protocolVersion: "0.1.0", name: "head-agent-core", version: "old-fixture",
    files: [...files].map(([relative, text]) => ({ path: relative, bytes: Buffer.byteLength(text), sha256: sha256(text) })).sort((a, b) => a.path.localeCompare(b.path, "en")),
  };
  const releaseId = `release-${sha256(canonical(identity)).slice(0, 24)}`;
  const release = path.join(root, "releases", releaseId);
  for (const [relative, text] of files) {
    const file = path.join(release, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { flag: "wx" });
  }
  const oldManifest = `${JSON.stringify({ ...identity, releaseId, packageName: "@local/head-agent-core-plugin" }, null, 2)}\n`;
  const oldOwnership = `${JSON.stringify({ product: "head-agent-core", protocolVersion: "0.1.0" })}\n`;
  fs.writeFileSync(path.join(release, "distribution-manifest.json"), oldManifest);
  fs.writeFileSync(path.join(root, "installation.json"), oldOwnership);
  fs.writeFileSync(path.join(root, "current.json"), JSON.stringify({ protocolVersion: "0.1.0", activeReleaseId: releaseId, history: [] }));
  const upgraded = installDistribution({ sourceRoot, installRoot: root, binDirectory: directory });
  assert.equal(upgraded.status, "upgraded");
  assert.equal(upgraded.previousReleaseId, releaseId);
  // Upgrade retains the historical owner and records the explicitly selected
  // launcher directory; immutable release bytes remain unchanged below.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "installation.json"), "utf8")),
    { ...JSON.parse(oldOwnership), binDirectory: path.resolve(directory) });
  for (const name of ["head", "lode"]) assert.equal(runGlobal(["--version"], name, directory).version, sourceVersion);
  rollbackDistribution({ installRoot: root, binDirectory: directory });
  for (const name of ["head", "lode"]) assert.equal(runGlobal(["--version"], name, directory).version, "old-fixture");
  assert.equal(fs.readFileSync(path.join(release, "distribution-manifest.json"), "utf8"), oldManifest);
  // An existing but unlisted lode.mjs must not win entrypoint selection.
  fs.writeFileSync(path.join(release, "scripts", "lode.mjs"), 'throw new Error("unlisted entrypoint executed");\n');
  assert.equal(runGlobal(["--version"], "lode", directory).version, "old-fixture");
  const oldHead = fs.readFileSync(path.join(release, "scripts", "head.mjs"));
  fs.appendFileSync(path.join(release, "scripts", "head.mjs"), "// integrity drift\n");
  const rejected = spawnSync(process.execPath, [path.join(directory, "lode-agent-launcher.mjs"), "--version"], { encoding: "utf8", shell: false, windowsHide: true });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /HEAD_DISTRIBUTION_FILE_DRIFT/);
  fs.writeFileSync(path.join(release, "scripts", "head.mjs"), oldHead);
  const aliases = ["HEAD_AGENT_INSTALL_ROOT", "LODE_AGENT_INSTALL_ROOT", "HEAD_AGENT_BIN_DIR", "LODE_AGENT_BIN_DIR"];
  const saved = aliases.map(name => process.env[name]);
  try {
    process.env.HEAD_AGENT_INSTALL_ROOT = root;
    process.env.LODE_AGENT_INSTALL_ROOT = root;
    process.env.HEAD_AGENT_BIN_DIR = directory;
    process.env.LODE_AGENT_BIN_DIR = directory;
    assert.equal(inspectDistribution().activeReleaseId, releaseId);
    process.env.LODE_AGENT_INSTALL_ROOT = path.join(scratchRoot, "different-install");
    assert.throws(() => inspectDistribution(), { code: "HEAD_DISTRIBUTION_INSTALL_ROOT_CONFLICT" });
  } finally {
    aliases.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
  const conflictingBin = path.join(scratchRoot, "unowned-lode-bin");
  fs.mkdirSync(conflictingBin);
  fs.writeFileSync(path.join(conflictingBin, "lode-agent.cmd"), "unowned\n");
  const pointerBefore = fs.readFileSync(path.join(root, "current.json"));
  assert.throws(() => installDistribution({ sourceRoot, installRoot: root, binDirectory: conflictingBin }), { code: "HEAD_DISTRIBUTION_COMMAND_CONFLICT" });
  assert.deepEqual(fs.readFileSync(path.join(root, "current.json")), pointerBefore);
  assert.equal(fs.readFileSync(path.join(conflictingBin, "lode-agent.cmd"), "utf8"), "unowned\n");
}

function runGlobalFailure(args) {
  const command = process.platform === "win32" ? path.join(binDirectory, "head-agent.cmd") : path.join(binDirectory, "head-agent");
  const machineArgs = args.includes("--json") ? args : [...args, "--json"];
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${command}" ${machineArgs.map((item) => `"${item}"`).join(" ")}"`], { encoding: "utf8", shell: false, windowsHide: true, windowsVerbatimArguments: true })
    : spawnSync(command, machineArgs, { encoding: "utf8", shell: false });
  assert.notEqual(result.status, 0);
  return JSON.parse(result.stdout);
}

try {
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "src", "request-service.mjs"), "export function acceptRequest() { return { accepted: true }; }\n", "utf8");
  const installed = runNode([
    path.join(sourceRoot, "scripts", "distribution.mjs"),
    "install",
    "--source", sourceRoot,
    "--install-root", installRoot,
    "--bin-dir", binDirectory,
    "--native", "off",
    "--project", projectRoot,
    "--runtime", "claude,codex,opencode",
    "--profile", "product",
  ]);
  assert.equal(installed.status, "installed");
  assert.equal(installed.version, sourceVersion);
  assert.equal(installed.project.projectAction, "initialized");
  assert.equal(installed.project.onboardingAction, "started");
  assert.equal(installed.project.status, "product_evidence_required");
  assert.equal(installed.project.onboarding.storageMode, "local");
  assert.equal(installed.project.onboarding.candidateCount, 0);
  const projectStorage = resolveProjectStorage(projectRoot);
  assert.ok(projectStorage);
  const generatedInstructions = fs.readFileSync(path.join(projectRoot, projectStorage.directory, "generated", `${projectStorage.dialect}-instructions.md`), "utf8").toLowerCase();
  assert.equal(runtimeForbiddenMarkers.some((marker) => generatedInstructions.includes(marker)), false);
  const installedReleaseRoot = path.join(installRoot, "releases", installed.releaseId);
  assert.equal(fs.existsSync(path.join(installedReleaseRoot, "legacy")), false, "standalone legacy migrator must not enter the installed runtime");
  const installedManifest = JSON.parse(fs.readFileSync(path.join(installedReleaseRoot, "distribution-manifest.json"), "utf8"));
  assert.equal(installedManifest.files.some((file) => file.path === "legacy" || file.path.startsWith("legacy/")), false);
  assert.equal(fs.existsSync(path.join(installedReleaseRoot, "scripts", "workspace-host-export-mcp.mjs")), true);
  assert.equal(fs.existsSync(path.join(installedReleaseRoot, "scripts", "verify-live-provider-coordination.mjs")), false);
  assert.equal(fs.existsSync(path.join(installedReleaseRoot, "scripts", "lib", "role-coordination.mjs")), false);
  assert.equal(fs.existsSync(path.join(installedReleaseRoot, "scripts", "verify-hostless-session-recovery.mjs")), true);
  assert.equal(fs.existsSync(path.join(installedReleaseRoot, "scripts", "lib", "workspace-host-export-driver.mjs")), true);
  assert.equal(fs.existsSync(path.join(installedReleaseRoot, "README.ko.md")), true);
  assert.equal(fs.readFileSync(path.join(installedReleaseRoot, "LICENSE"), "utf8"), fs.readFileSync(path.join(sourceRoot, "LICENSE"), "utf8"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(installedReleaseRoot, ".codex-plugin", "plugin.json"), "utf8")).license, "MIT");
  assert.equal(JSON.parse(fs.readFileSync(path.join(installedReleaseRoot, "package.json"), "utf8")).license, "MIT");
  assert.equal(fs.readFileSync(path.join(installedReleaseRoot, "README.md"), "utf8").includes("[한국어](README.ko.md)"), true);
  assert.equal(fs.readFileSync(path.join(installedReleaseRoot, "README.ko.md"), "utf8").includes("[English](README.md)"), true);
  assertRuntimeSurfaceIsolated(installedReleaseRoot);
  assert.equal(fs.existsSync(path.join(projectRoot, ".git")), false);
  assert.equal(inspectDistribution({ installRoot, binDirectory }).activeReleaseId, installed.releaseId);

  const command = process.platform === "win32" ? path.join(binDirectory, "lode-agent.cmd") : path.join(binDirectory, "lode-agent");
  const version = process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${command}" --version"`], { encoding: "utf8", shell: false, windowsHide: true, windowsVerbatimArguments: true })
    : spawnSync(command, ["--version"], { encoding: "utf8", shell: false });
  assert.equal(version.status, 0, version.stderr || version.error?.message);
  assert.equal(JSON.parse(version.stdout).version, sourceVersion);

  fs.mkdirSync(coreOnlyProjectRoot, { recursive: true });
  fs.writeFileSync(path.join(coreOnlyProjectRoot, "core.mjs"), "export const coordinated = true;\n", "utf8");
  const coreOnly = runGlobal(["init", coreOnlyProjectRoot, "--runtime", "codex"]);
  assert.equal(coreOnly.status, "core_ready");
  assert.equal(coreOnly.profile, "core");
  assert.equal(coreOnly.productGovernanceActivated, false);
  assert.equal(coreOnly.onboardingAction, "not-activated");
  assert.equal(coreOnly.onboarding.candidateSetId, null);

  const projectBeforeResume = JSON.parse(fs.readFileSync(projectStorage.projectFile, "utf8"));
  const sessionBeforeResume = JSON.parse(fs.readFileSync(path.join(projectRoot, projectStorage.directory, "sessions", "current.json"), "utf8"));
  const onboardingStateFile = path.join(projectRoot, projectStorage.directory, "onboarding", "current.json");
  const onboardingBeforeResume = fs.readFileSync(onboardingStateFile, "utf8");
  const resumed = runGlobal(["resume", projectRoot, "--runtime", "claude,codex,opencode", "--profile", "product"]);
  assert.equal(resumed.projectAction, "resumed");
  assert.equal(resumed.status, "product_evidence_required");
  assert.equal(resumed.onboardingAction, "evidence-required");
  assert.equal(resumed.project.projectId, projectBeforeResume.projectId);
  assert.equal(resumed.project.sessionId, sessionBeforeResume.sessionId);
  assert.equal(fs.readFileSync(onboardingStateFile, "utf8"), onboardingBeforeResume);

  const managedOpenCodeFile = path.join(projectRoot, "opencode.json");
  const managedOpenCodeBeforeDrift = fs.readFileSync(managedOpenCodeFile, "utf8");
  fs.writeFileSync(managedOpenCodeFile, `${managedOpenCodeBeforeDrift}\nuser-edit`, "utf8");
  const driftFailure = runGlobalFailure(["resume", projectRoot, "--runtime", "claude,codex,opencode", "--profile", "product"]);
  assert.equal(driftFailure.code, "PROJECT_NOT_READY");
  assert.equal(fs.readFileSync(managedOpenCodeFile, "utf8"), `${managedOpenCodeBeforeDrift}\nuser-edit`);
  fs.writeFileSync(managedOpenCodeFile, managedOpenCodeBeforeDrift, "utf8");

  fs.mkdirSync(evidenceResumeProjectRoot, { recursive: true });
  const awaitingEvidence = runGlobal(["init", evidenceResumeProjectRoot, "--runtime", "codex", "--profile", "product"]);
  assert.equal(awaitingEvidence.status, "product_evidence_required");
  assert.equal(awaitingEvidence.onboarding.candidateCount, 0);
  fs.mkdirSync(path.join(evidenceResumeProjectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(evidenceResumeProjectRoot, "src", "capture.mjs"), "export function captureDepthImage() { return true; }\n", "utf8");
  const resumedEvidence = runGlobal(["resume", evidenceResumeProjectRoot, "--runtime", "codex", "--profile", "product"]);
  assert.equal(resumedEvidence.status, "product_evidence_required");
  assert.equal(resumedEvidence.onboardingAction, "evidence-required");
  assert.equal(resumedEvidence.onboarding.candidateCount, 0);
  assert.equal(resumedEvidence.project.projectId, awaitingEvidence.project.projectId);
  assert.equal(resumedEvidence.project.sessionId, awaitingEvidence.project.sessionId);

  copySourceFixture();
  const upgradedReadmeFile = path.join(upgradedSource, "README.md");
  const upgradedReadme = fs.readFileSync(upgradedReadmeFile, "utf8");
  fs.writeFileSync(upgradedReadmeFile, `${upgradedReadme}\n${runtimeForbiddenMarkers[1]}\n`, "utf8");
  assert.throws(
    () => installDistribution({ sourceRoot: upgradedSource, installRoot, binDirectory }),
    (error) => error.code === "HEAD_DISTRIBUTION_DEVELOPMENT_CONTEXT_LEAK",
  );
  assert.equal(inspectDistribution({ installRoot, binDirectory }).activeReleaseId, installed.releaseId);
  fs.writeFileSync(upgradedReadmeFile, upgradedReadme, "utf8");
  const upgradedPluginFile = path.join(upgradedSource, ".codex-plugin", "plugin.json");
  const upgradedPlugin = JSON.parse(fs.readFileSync(upgradedPluginFile, "utf8"));
  fs.writeFileSync(upgradedPluginFile, `${JSON.stringify({ ...upgradedPlugin, version: "mismatched-e2e" }, null, 2)}\n`, "utf8");
  assert.throws(
    () => installDistribution({ sourceRoot: upgradedSource, installRoot, binDirectory }),
    (error) => error.code === "HEAD_DISTRIBUTION_VERSION_MISMATCH",
  );
  assert.equal(inspectDistribution({ installRoot, binDirectory }).activeReleaseId, installed.releaseId);
  fs.writeFileSync(upgradedPluginFile, `${JSON.stringify(upgradedPlugin, null, 2)}\n`, "utf8");
  const upgradedPackageFile = path.join(upgradedSource, "package.json");
  const upgradedPackage = JSON.parse(fs.readFileSync(upgradedPackageFile, "utf8"));
  fs.writeFileSync(upgradedPackageFile, `${JSON.stringify({ ...upgradedPackage, license: "Apache-2.0" }, null, 2)}\n`, "utf8");
  assert.throws(
    () => installDistribution({ sourceRoot: upgradedSource, installRoot, binDirectory }),
    (error) => error.code === "HEAD_DISTRIBUTION_LICENSE_MISMATCH",
  );
  assert.equal(inspectDistribution({ installRoot, binDirectory }).activeReleaseId, installed.releaseId);
  fs.writeFileSync(upgradedPackageFile, `${JSON.stringify(upgradedPackage, null, 2)}\n`, "utf8");
  const upgraded = runNode([
    path.join(sourceRoot, "scripts", "distribution.mjs"),
    "upgrade",
    "--source", upgradedSource,
    "--install-root", installRoot,
    "--bin-dir", binDirectory,
    "--native", "off",
    "--project", projectRoot,
    "--runtime", "claude,codex,opencode",
    "--profile", "product",
  ]);
  assert.equal(upgraded.status, "upgraded");
  assert.notEqual(upgraded.releaseId, installed.releaseId);
  const upgradedReleaseRoot = path.join(installRoot, "releases", upgraded.releaseId);
  for (const relative of [".agent-work", "docs/.agent-work", "scripts/nested/.agent-work", "skills/.AGENT-WORK"]) {
    assert.equal(fs.existsSync(path.join(upgradedReleaseRoot, relative)), false);
  }
  assert.equal(fs.existsSync(path.join(upgradedReleaseRoot, "docs/.custom-source/keep.md")), true);
  assert.equal(upgraded.project.installationAction, "converged");
  assert.equal(upgraded.project.project.projectId, projectBeforeResume.projectId);
  await verifyOpenCodeInstallation(upgradedReleaseRoot);
  assert.equal(inspectDistribution({ installRoot, binDirectory }).rollbackReleaseId, installed.releaseId);

  const rolledBack = rollbackDistribution({ installRoot, binDirectory });
  assert.equal(rolledBack.status, "rolled-back");
  assert.equal(rolledBack.activeReleaseId, installed.releaseId);
  assert.equal(inspectDistribution({ installRoot, binDirectory }).version, sourceVersion);
  const resumedAfterRollback = runGlobal(["resume", projectRoot, "--runtime", "claude,codex,opencode", "--profile", "product"]);
  assert.equal(resumedAfterRollback.installationAction, "converged");
  assert.equal(resumedAfterRollback.project.projectId, projectBeforeResume.projectId);
  await verifyOpenCodeInstallation(installedReleaseRoot);

  const uninstalled = uninstallDistribution({ installRoot, binDirectory, purge: false });
  assert.equal(uninstalled.status, "uninstalled");
  assert.equal(uninstalled.projectStatePreserved, true);
  assert.equal(fs.existsSync(path.join(installRoot, "releases", installed.releaseId)), true);
  assert.equal(fs.existsSync(command), false);

  const purged = uninstallDistribution({ installRoot, binDirectory, purge: true });
  assert.equal(purged.status, "not-installed");
  assert.equal(fs.existsSync(installRoot), false);

  verifyHistoricalEntrypointRollback();

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    installedReleaseId: installed.releaseId,
    upgradedReleaseId: upgraded.releaseId,
    rollbackVerified: true,
    syntheticHistoricalEntrypointRollbackVerified: true,
    bothLauncherAliasesVerified: true,
    failedUpgradePreservedCurrent: true,
    launcherVerified: true,
    workspaceHostExportBridgePackaged: true,
    retiredRoleAndLiveCoordinationImplementationsExcluded: true,
    hostlessSessionRecoveryVerifierPackaged: true,
    publicInitializeResumeVerified: true,
    constitutionalCoreDefaultVerified: true,
    runtimeDevelopmentContextExcluded: true,
    mitLicensePackaged: true,
    projectAuthorityDeduplicated: true,
    gitAndGraphDbIndependentOnboardingVerified: true,
    managedProjectionConvergenceVerified: true,
    managedDriftRejectedWithoutOverwrite: true,
    awaitingEvidenceResumeVerified: true,
    projectStatePreserved: true,
  }, null, 2)}\n`);
} finally {
  if (fs.existsSync(scratchRoot)) fs.rmSync(scratchRoot, { recursive: true, force: true });
}

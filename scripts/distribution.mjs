#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { installDistribution, inspectDistribution, rollbackDistribution, uninstallDistribution } from "./lib/distribution-lifecycle.mjs";
import { initializeOrResumeProject } from "./lib/project-bootstrap.mjs";
import { acquireVerifiedNativeArtifact } from "./lib/native-artifact-delivery.mjs";

function parse(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    if (key === "purge") {
      options.purge = true;
      continue;
    }
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`A value is required for ${item}.`);
    options[key] = value;
  }
  return { command, options };
}

function usage() {
  return {
    commands: [
      "distribution install [--source <plugin-source>] [--install-root <directory>] [--bin-dir <directory>] [--native auto|off|required] [--project <directory> --runtime claude,codex,opencode --profile core|product --onboarding-input <json>]",
      "distribution upgrade [--source <plugin-source>] [--install-root <directory>] [--bin-dir <directory>] [--native auto|off|required] [--project <directory> --runtime claude,codex,opencode --profile core|product --onboarding-input <json>]",
      "distribution status [--install-root <directory>] [--bin-dir <directory>]",
      "distribution doctor [--install-root <directory>] [--bin-dir <directory>]",
      "distribution rollback [--install-root <directory>] [--bin-dir <directory>]",
      "distribution uninstall [--install-root <directory>] [--bin-dir <directory>] [--purge]",
    ],
  };
}

function readOnboardingInput(file) {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); }
  catch (error) { throw new Error(`Onboarding input is invalid JSON: ${error.message}`); }
}

export async function runDistributionCommand(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  const common = { installRoot: options["install-root"], binDirectory: options["bin-dir"] };
  if (command === "help" || command === "--help" || command === "-h") return usage();
  if (command === "install" || command === "upgrade") {
    if (!options.project && (options.runtime || options.profile || options["onboarding-input"])) {
      throw new Error("--runtime, --profile, and --onboarding-input require --project.");
    }
    const sourceRoot = path.resolve(options.source || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const sourcePackage = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
    const acquisition = await acquireVerifiedNativeArtifact({ version: sourcePackage.version, mode: options.native || "auto" });
    try {
      const distribution = installDistribution({
        ...common,
        sourceRoot,
        nativeOverlayRoot: acquisition.status === "verified" ? acquisition.pluginRoot : null,
      });
      distribution.native = acquisition.status === "verified"
        ? { ...distribution.native, assetName: acquisition.assetName, assetSha256: acquisition.assetSha256, buildCommit: acquisition.buildCommit }
        : { status: "javascript-fallback", deliveryStatus: acquisition.status, reasonCode: acquisition.reasonCode || null };
      if (!options.project) return distribution;
      const activePluginRoot = path.join(distribution.installRoot, "releases", distribution.releaseId);
      const project = await initializeOrResumeProject({
        root: options.project,
        pluginRoot: activePluginRoot,
        runtimes: options.runtime?.split(","),
        profile: options.profile || "core",
        onboarding: readOnboardingInput(options["onboarding-input"]),
      });
      return { ...distribution, project };
    } finally {
      acquisition.cleanup();
    }
  }
  if (command === "status" || command === "doctor") return inspectDistribution(common);
  if (command === "rollback") return rollbackDistribution(common);
  if (command === "uninstall") return uninstallDistribution({ ...common, purge: options.purge });
  throw new Error(`Unknown distribution command: ${command}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  Promise.resolve().then(async () => (await runDistributionCommand())).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stdout.write(`${JSON.stringify({ status: "failed", code: error.code || "HEAD_DISTRIBUTION_ERROR", error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

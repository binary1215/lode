#!/usr/bin/env node
import path from "node:path";
import { buildCodexMarketplaceSnapshot } from "./lib/codex-marketplace.mjs";
import { ARTIFACT_COMPOSITION } from "./lib/lode-artifact-composition.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || "";
}

try {
  const output = option("--output");
  if (!output) throw Object.assign(new Error("--output is required."), { code: "HEAD_CODEX_MARKETPLACE_OUTPUT_REQUIRED" });
  const report = buildCodexMarketplaceSnapshot({
    sourceRoot: path.resolve(option("--source", ".")),
    outputRoot: path.resolve(output),
    name: option("--marketplace-name", ARTIFACT_COMPOSITION.marketplaceName),
    displayName: option("--display-name", "Lode Agent Plugin"),
    repository: option("--source-repository", "local"),
    commit: option("--source-commit", "local"),
    nativeOverlayRoot: option("--native-root") ? path.resolve(option("--native-root")) : null,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "error", code: error.code || "HEAD_CODEX_MARKETPLACE_BUILD_FAILED", message: error.message })}\n`);
  process.exitCode = 1;
}

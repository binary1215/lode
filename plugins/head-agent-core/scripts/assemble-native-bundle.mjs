#!/usr/bin/env node

import path from "node:path";
import { assembleVerifiedNativeBundle } from "./lib/native-artifact-delivery.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || "";
}

try {
  const artifactsRoot = option("--artifacts");
  const outputRoot = option("--output");
  const version = option("--version");
  const commit = option("--commit");
  if (!artifactsRoot || !outputRoot || !version) {
    throw Object.assign(new Error("--artifacts, --output, and --version are required."), { code: "HEAD_NATIVE_BUNDLE_ARGUMENTS" });
  }
  const result = assembleVerifiedNativeBundle({
    artifactsRoot: path.resolve(artifactsRoot),
    outputRoot: path.resolve(outputRoot),
    version,
    commit: commit || null,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "error", code: error.code || "HEAD_NATIVE_BUNDLE_ASSEMBLY_FAILED", message: error.message })}\n`);
  process.exitCode = 1;
}

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createGoWorkerManifest, WORKER_HEALTH_OPERATION } from "./lib/go-worker-adapter.mjs";

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error("Arguments must be --name value pairs.");
    const name = key.slice(2);
    if (!["platform", "arch", "binary", "output", "operations"].includes(name) || result[name] != null) throw new Error(`Unsupported or duplicate argument: ${key}`);
    result[name] = value;
  }
  for (const name of ["platform", "arch", "binary", "output"]) if (!result[name]) throw new Error(`--${name} is required.`);
  return result;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const output = path.resolve(options.output);
  const manifestDirectory = path.dirname(output);
  if (path.basename(output) !== "WORKER-MANIFEST.json") throw new Error("--output must end in WORKER-MANIFEST.json.");
  const operations = options.operations ? options.operations.split(",").filter(Boolean) : [WORKER_HEALTH_OPERATION];
  const manifest = createGoWorkerManifest({
    platform: options.platform,
    arch: options.arch,
    binaryFile: path.resolve(options.binary),
    manifestDirectory,
    operations,
  });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({ status: "created", output, manifestId: manifest.manifestId })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

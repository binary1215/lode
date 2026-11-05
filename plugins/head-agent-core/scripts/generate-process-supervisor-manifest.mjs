#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createProcessSupervisorManifest } from "./lib/runtime-process-supervisor.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
}

const platform = option("--platform");
const arch = option("--arch");
const binaryFile = path.resolve(option("--binary"));
const output = path.resolve(option("--output"));
const manifest = createProcessSupervisorManifest({ platform, arch, binaryFile, manifestDirectory: path.dirname(output) });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ status: "created", output, manifestId: manifest.manifestId })}\n`);

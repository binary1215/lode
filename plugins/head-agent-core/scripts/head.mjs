#!/usr/bin/env node
// Exact historical entrypoint; all execution and exports belong to Lode.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliMain } from "./lode.mjs";
export { parse, usage, runCommand, runCliMain } from "./lode.mjs";

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runCliMain();

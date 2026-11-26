#!/usr/bin/env node
// Collects the reason codes the shipped JavaScript uses, for REASON_CODES in
// scripts/lib/core/errors.mjs.
//
//   node scripts/codemods/reason-codes.mjs          print the collected list as JSON
//   node scripts/codemods/reason-codes.mjs --write  rewrite REASON_CODES in errors.mjs
//
// A reason code is an UPPER_SNAKE string literal (at least one underscore) that is
//   - the value of a `code` or `reasonCode` property, default or assignment
//     (including an `x || "CODE"` fallback), or
//   - a direct string argument of a call whose name contains "fail"/"Fail" or
//     ends in "error"/"Error" (sourceError, inputError, ...).
// Codes that only pass through another helper (readJson(file, "CODE")) are not
// collected unless they also appear in one of those positions.
import fs from "node:fs";
import path from "node:path";
import { callArguments } from "./js-scan.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "../..");
export const ERRORS_FILE = "scripts/lib/core/errors.mjs";
const CODE = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+";
const PROPERTY = new RegExp(`(?<![\\w$])(?:code|reasonCode)\\s*(?::|=(?!=))\\s*(?:[^,;\\n]*?\\|\\|\\s*)?"(${CODE})"`, "g");
const FAIL_CALL = /(?<![\w$.])(\w*[fF]ail\w*|\w*[eE]rror)\(/g;
const LITERAL = new RegExp(`^\\s*"(${CODE})"\\s*$`);

export function reasonCodeSources(root = pluginRoot) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!["scripts/codemods", "node_modules"].includes(relative)) walk(file);
      } else if (entry.name.endsWith(".mjs") && relative !== ERRORS_FILE) files.push(file);
    }
  };
  walk(path.join(root, "scripts"));
  walk(path.join(root, "compat"));
  return files.sort();
}

export function collectReasonCodes(root = pluginRoot) {
  const codes = new Set();
  for (const file of reasonCodeSources(root)) {
    const src = fs.readFileSync(file, "utf8");
    for (const match of src.matchAll(PROPERTY)) codes.add(match[1]);
    for (const match of src.matchAll(FAIL_CALL)) {
      let args;
      try {
        ({ args } = callArguments(src, match.index + match[0].length - 1));
      } catch {
        continue;
      }
      for (const arg of args) {
        const literal = LITERAL.exec(arg);
        if (literal) codes.add(literal[1]);
      }
    }
  }
  return [...codes].sort();
}

export function renderReasonCodes(text, codes) {
  const start = text.indexOf("export const REASON_CODES = Object.freeze([");
  const end = text.indexOf("]);", start);
  if (start < 0 || end < 0) throw new Error("REASON_CODES block not found");
  const body = codes.map((code) => `  "${code}",\n`).join("");
  return `${text.slice(0, start)}export const REASON_CODES = Object.freeze([\n${body}${text.slice(end)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const codes = collectReasonCodes();
  if (process.argv.includes("--write")) {
    const file = path.join(pluginRoot, ERRORS_FILE);
    fs.writeFileSync(file, renderReasonCodes(fs.readFileSync(file, "utf8"), codes));
    console.log(JSON.stringify({ status: "written", file: ERRORS_FILE, codes: codes.length }));
  } else console.log(JSON.stringify(codes, null, 2));
}

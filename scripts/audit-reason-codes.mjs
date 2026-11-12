#!/usr/bin/env node
// Read-only reason-code audit (design 4.6, survey step). For every entry of
// REASON_CODES it counts where the code appears in the tracked files:
//   prefixBranch  a shipped `code.startsWith("PREFIX")` covers it
//   branch        a shipped line compares it (===, !==, case, includes, has, test)
//   keyed         a shipped object maps it (`CODE: …`)
//   list          a shipped array/Set literal lists it (often used to branch)
//   emit          any other shipped occurrence (a fail/Error/code field)
//   go            native Go sources
//   doc / skill   English docs and README / skills
//   test          tests and verify/codemod scripts
// A code with none of prefixBranch/branch/keyed/list/doc/skill/go is "quiet": only
// its message tells an agent or a user anything. Heuristic, line-based counts; it
// prints a summary, `--json` prints every row. Nothing is written.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const { REASON_CODES, LEGACY_REASON_CODES } = await import(pathToFileURL(path.join(root, "scripts/lib/core/errors.mjs")).href);

const kind = (file) => {
  if (file === "scripts/lib/core/errors.mjs") return "registry";
  if (/^scripts\/(verify-|codemods\/|audit-)/.test(file)) return "test";
  if (/^(scripts|hooks|compat|legacy)\/.*\.(mjs|cjs|js)$/.test(file)) return "code";
  if (/^native\/.*\.go$/.test(file)) return "go";
  if (/^test\//.test(file)) return "test";
  if (/^skills\//.test(file)) return "skill";
  if (/^docs\/(?!ko\/).*\.md$|^README\.md$|^CONTRIBUTING\.md$/.test(file)) return "doc";
  return null;
};
const token = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const compare = /===|!==|\bcase\s|\.includes\(|\.has\(|\.test\(/;
const emitting = /\bfail\w*\(|Error\(|new \w+Error/;
const listLine = /^\s*["'][A-Z0-9_]+["'],\s*$|^\s*["'][A-Z0-9_]+["']\s*\]|\[\s*["'][A-Z0-9_]+["']\s*,/;
const prefixBranch = /(?:code|reasonCode|Code)\??\.startsWith\(\s*["']([A-Z][A-Z0-9_]*)["']/g;

export function auditReasonCodes() {
  const known = new Set(REASON_CODES);
  const stats = new Map(
    REASON_CODES.map((code) => [code, { prefixBranch: 0, branch: 0, keyed: 0, list: 0, emit: 0, go: 0, doc: 0, skill: 0, test: 0, branchSites: [] }]),
  );
  const prefixes = new Map();
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n");
  for (const file of files) {
    const area = kind(file);
    if (!area || area === "registry") continue;
    fs.readFileSync(path.join(root, file), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (area === "code")
          for (const match of line.matchAll(prefixBranch)) prefixes.set(match[1], [...(prefixes.get(match[1]) ?? []), `${file}:${index + 1}`]);
        for (const match of line.matchAll(token)) {
          const code = match[0];
          if (!known.has(code)) continue;
          const row = stats.get(code);
          if (area !== "code") row[area]++;
          else if (compare.test(line) && !emitting.test(line)) {
            row.branch++;
            if (row.branchSites.length < 3) row.branchSites.push(`${file}:${index + 1}`);
          } else if (new RegExp(`^\\s*["']?${code}["']?\\s*:`).test(line)) row.keyed++;
          else if (listLine.test(line)) row.list++;
          else row.emit++;
        }
      });
  }
  for (const [code, row] of stats) for (const prefix of prefixes.keys()) if (code.startsWith(prefix)) row.prefixBranch++;
  const legacy = new Set(Object.values(LEGACY_REASON_CODES));
  const rows = [...stats].map(([code, row]) => ({ code, area: code.split("_")[0], legacy: legacy.has(code), ...row }));
  return { rows, prefixes: Object.fromEntries(prefixes) };
}

export const consumed = (row) => row.prefixBranch + row.branch + row.keyed + row.list + row.go > 0;
export const documented = (row) => row.doc + row.skill > 0;
export const quiet = (row) => !consumed(row) && !documented(row);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { rows, prefixes } = auditReasonCodes();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
  } else {
    const count = (predicate) => rows.filter(predicate).length;
    const areas = {};
    for (const row of rows) {
      const entry = (areas[row.area] ??= { total: 0, consumed: 0, documented: 0, quiet: 0, quietTested: 0 });
      entry.total++;
      if (consumed(row)) entry.consumed++;
      if (documented(row)) entry.documented++;
      if (quiet(row)) entry.quiet++;
      if (quiet(row) && row.test) entry.quietTested++;
    }
    const summary = {
      codes: rows.length,
      prefixBranched: count((row) => row.prefixBranch > 0),
      branched: count((row) => row.branch > 0),
      keyedOnly: count((row) => !row.branch && row.keyed > 0),
      listedOnly: count((row) => !row.branch && !row.keyed && row.list > 0),
      go: count((row) => row.go > 0),
      consumed: count(consumed),
      documented: count(documented),
      skills: count((row) => row.skill > 0),
      tested: count((row) => row.test > 0),
      quiet: count(quiet),
      quietTested: count((row) => quiet(row) && row.test > 0),
      legacySpelling: count((row) => row.legacy),
      prefixBranches: Object.fromEntries(Object.entries(prefixes).map(([prefix, sites]) => [prefix, sites.length])),
      areas: Object.fromEntries(Object.entries(areas).sort((left, right) => right[1].total - left[1].total)),
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

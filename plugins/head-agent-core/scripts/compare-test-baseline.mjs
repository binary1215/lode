#!/usr/bin/env node
// Compare the failing-test sets of two TAP files (node --test --test-reporter=tap).
// Some suites always fail on a given machine (missing Go toolchain, OS policy), so a
// branch is judged by the difference from its base, not by the absolute fail count.
//
//   node scripts/compare-test-baseline.mjs <base.tap> <branch.tap> [--json]
//
// Exit 0 when the branch adds no failing test, 1 when it does, 2 on a usage error.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function failingTests(tapText) {
  const failing = new Map();
  const stack = [];
  let total = null;
  for (const raw of tapText.split(/\r?\n/)) {
    const depth = Math.floor((raw.length - raw.trimStart().length) / 4);
    const line = raw.trim();
    const subtest = /^# Subtest: (.*)$/.exec(line);
    if (subtest) {
      stack.length = depth;
      stack[depth] = subtest[1];
      continue;
    }
    const result = /^(not ok|ok) \d+(?: - (.*))?$/.exec(line);
    if (result) {
      const [name, directive] = splitDirective(result[2] ?? "");
      stack.length = depth;
      if (result[1] === "not ok" && !/^TODO\b/i.test(directive)) {
        const key = [...stack, name].join(" > ");
        failing.set(key, (failing.get(key) ?? 0) + 1);
      }
      continue;
    }
    const tests = depth === 0 ? /^# tests (\d+)$/.exec(line) : null;
    if (tests) total = Number(tests[1]);
  }
  return { failing, total };
}

function splitDirective(text) {
  const match = /^(.*?)\s+# (TODO|SKIP)\b(.*)$/i.exec(text);
  return match ? [match[1], `${match[2]}${match[3]}`] : [text, ""];
}

export function compareFailing(base, branch) {
  const added = [],
    fixed = [];
  for (const [name, count] of branch.failing) {
    for (let i = base.failing.get(name) ?? 0; i < count; i++) added.push(name);
  }
  for (const [name, count] of base.failing) {
    for (let i = branch.failing.get(name) ?? 0; i < count; i++) fixed.push(name);
  }
  return { added: added.sort(), fixed: fixed.sort() };
}

function count(map) {
  let sum = 0;
  for (const value of map.values()) sum += value;
  return sum;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const files = args.filter((arg) => arg !== "--json");
  if (files.length !== 2) {
    process.stderr.write("usage: node scripts/compare-test-baseline.mjs <base.tap> <branch.tap> [--json]\n");
    process.exit(2);
  }
  const [base, branch] = files.map((file) => failingTests(fs.readFileSync(file, "utf8")));
  const { added, fixed } = compareFailing(base, branch);
  const summary = {
    base: { file: files[0], tests: base.total, failing: count(base.failing) },
    branch: { file: files[1], tests: branch.total, failing: count(branch.failing) },
    newFailures: added,
    fixedFailures: fixed,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    const lines = [
      `base:   ${summary.base.tests ?? "?"} tests, ${summary.base.failing} failing (${files[0]})`,
      `branch: ${summary.branch.tests ?? "?"} tests, ${summary.branch.failing} failing (${files[1]})`,
      `new failures: ${added.length}`,
      ...added.map((name) => `  + ${name}`),
      `fixed failures: ${fixed.length}`,
      ...fixed.map((name) => `  - ${name}`),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  process.exit(added.length ? 1 : 0);
}

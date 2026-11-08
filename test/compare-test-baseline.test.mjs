import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareFailing, failingTests } from "../scripts/compare-test-baseline.mjs";

const script = path.resolve(import.meta.dirname, "../scripts/compare-test-baseline.mjs");

const tap = lines => `TAP version 13\n${lines.join("\n")}\n`;
const base = tap([
  "# Subtest: always fails without Go",
  "not ok 1 - always fails without Go",
  "# Subtest: parent",
  "    # Subtest: child",
  "    not ok 1 - child",
  "    1..1",
  "not ok 2 - parent",
  "# Subtest: fixed later",
  "not ok 3 - fixed later",
  "# Subtest: pending",
  "not ok 4 - pending # TODO not written",
  "ok 5 - skipped # SKIP optional helper",
  "1..5",
  "# tests 6",
  "# fail 4"
]);
const branch = tap([
  "# Subtest: always fails without Go",
  "not ok 1 - always fails without Go",
  "# Subtest: parent",
  "    # Subtest: child",
  "    not ok 1 - child",
  "    1..1",
  "not ok 2 - parent",
  "# Subtest: fixed later",
  "ok 3 - fixed later",
  "# Subtest: new break",
  "not ok 4 - new break",
  "# Subtest: always fails without Go",
  "not ok 5 - always fails without Go",
  "1..5",
  "# tests 6"
]);

test("failing names keep their subtest path, count duplicates and ignore TODO and SKIP", () => {
  const parsed = failingTests(base);
  assert.equal(parsed.total, 6);
  assert.deepEqual([...parsed.failing], [
    ["always fails without Go", 1],
    ["parent > child", 1],
    ["parent", 1],
    ["fixed later", 1]
  ]);
});

test("the comparison reports only new and fixed failures", () => {
  assert.deepEqual(compareFailing(failingTests(base), failingTests(branch)), {
    added: ["always fails without Go", "new break"],
    fixed: ["fixed later"]
  });
  assert.deepEqual(compareFailing(failingTests(base), failingTests(base)), { added: [], fixed: [] });
});

test("the CLI exits 1 on a new failure, 0 without one and 2 on a usage error", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-compare-baseline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseFile = path.join(root, "base.tap"), branchFile = path.join(root, "branch.tap");
  fs.writeFileSync(baseFile, base);
  fs.writeFileSync(branchFile, branch);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const changed = run(baseFile, branchFile, "--json");
  assert.equal(changed.status, 1);
  const summary = JSON.parse(changed.stdout);
  assert.deepEqual(summary.newFailures, ["always fails without Go", "new break"]);
  assert.deepEqual(summary.fixedFailures, ["fixed later"]);
  assert.deepEqual([summary.base.failing, summary.branch.failing], [4, 5]);
  const same = run(baseFile, baseFile);
  assert.equal(same.status, 0);
  assert.match(same.stdout, /new failures: 0\nfixed failures: 0\n$/);
  assert.equal(run(baseFile).status, 2);
});

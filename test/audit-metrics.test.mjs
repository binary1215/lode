// Smoke test: the audit script runs and reports each metric. It asserts no
// limits on the values (the script is print-only by design).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const script = path.resolve(import.meta.dirname, "..", "scripts", "audit-metrics.mjs");

test("audit-metrics prints every metric as a table and as JSON", () => {
  const table = execFileSync(process.execPath, [script], { encoding: "utf8" });
  for (const name of [
    "always-read chars",
    "prohibitions",
    "tools: default tools/list",
    "tools/list result size",
    "calls: save",
    "calls: resume",
    "calls: delegation",
  ])
    assert.ok(table.includes(name), `table names ${name}`);

  const report = JSON.parse(execFileSync(process.execPath, [script, "--json"], { encoding: "utf8" }));
  assert.equal(report.kind, "LodeAuditMetrics");
  assert.ok(report.alwaysRead.sources.length > 0);
  assert.deepEqual(report.prohibitions.phrases, ["never", "do not", "must not", "cannot"]);
  assert.equal(typeof report.tools.defaultToolsList, "number");
  for (const task of ["save", "resume", "delegation"]) assert.ok(report.calls[task].length > 0, `calls.${task}`);
});

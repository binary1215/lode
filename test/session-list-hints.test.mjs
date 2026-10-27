import assert from "node:assert/strict";
import test from "node:test";
import { formatCliResult, formatMcpToolContent } from "../scripts/lib/cli-presentation.mjs";

test("Session hints expose recorded work pointers and update only; preserve every Session and raw field", () => {
  const value = { projectId: "synthetic-project", defaultSessionId: "chosen", sessions: [
    { sessionId: "chosen", purpose: "Current explicit work", default: true, state: {
      activeRunId: "run-1", pendingReview: { reviewId: "review-1" }, requiredPlanAction: { action: "revise" },
      updatedAt: "2000-01-01T00:00:00Z", custom: "retain original" } },
    { sessionId: "other", purpose: "Independent work", default: false, state: {
      activeRunId: null, pendingReview: null, requiredPlanAction: null, latestCheckpoint: "checkpoint-2" } },
  ] };
  const before = structuredClone(value), cli = formatCliResult("session-list", value);
  assert.equal(cli, formatMcpToolContent("head_session_list", value));
  assert.deepEqual(value, before);
  assert.match(cli, /stored P2 pointers; not freshly verified execution or completion/);
  assert.match(cli, /Stored pointers only; recent work and remaining tasks are uninspected until an exact preview/);
  assert.match(cli, /sessions\[0\]\.state\.updatedAt: "2000-01-01T00:00:00Z"/);
  assert.match(cli, /sessions\[0\]\.state\.activeRunId: "run-1"/);
  assert.match(cli, /sessions\[0\]\.state\.pendingReview: \{"reviewId":"review-1"\}/);
  assert.match(cli, /sessions\[0\]\.state\.requiredPlanAction: \{"action":"revise"\}/);
  assert.match(cli, /sessions\[1\]\.state\.activeRunId: null/);
  assert.match(cli, /sessions\[1\]\.state\.pendingReview: null/);
  assert.doesNotMatch(cli, /sessions\[1\]\.state\.updatedAt:/);
  for (const text of ["chosen", "other", "Current explicit work", "Independent work", "run-1", "review-1", "checkpoint-2", "retain original"])
    assert.ok(cli.includes(text), text);
  assert.doesNotMatch(cli, /auto.?archive|inactive|completed successfully|live running/i);
});

test("Session hints do not manufacture state, sort, or hide malformed and empty entries", () => {
  const value = { sessions: [null, { sessionId: "missing-state" }, { sessionId: "empty", state: {} }] };
  const before = structuredClone(value), text = formatCliResult("session-list", value);
  assert.deepEqual(value, before);
  assert.equal((text.match(/Session\[/g) || []).length, 3);
  assert.ok(text.indexOf("missing-state") < text.indexOf('"empty"'));
  assert.equal((text.match(/Stored pointers only;/g) || []).length, 1);
  assert.doesNotMatch(text, /sessions\[1\]\.state\./);
  assert.doesNotMatch(text, /\.updatedAt:/);
});

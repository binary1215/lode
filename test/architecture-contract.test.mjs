import assert from "node:assert/strict";
import test from "node:test";
import { discoverTools } from "../scripts/mcp-server.mjs";

test("the typed user-review operation is a routed mutation while status and graph reads stay read-only", () => {
  const discovery = discoverTools({ name: "lode_onboarding_review" }, "ordinary"), review = discovery.tools[0];
  assert.equal(discovery.grantsAuthorization, false);
  assert(review); assert.equal(review.annotations.readOnlyHint, false); assert.equal(review.invokeWith, "lode_tools_call");
  assert.equal(review.executionMode, undefined, "Product review is not worker-managed execution");
  for (const name of ["lode_onboarding_status", "lode_project_graph"]) {
    assert.equal(discoverTools({ name }, "ordinary").tools[0].annotations.readOnlyHint, true);
  }
});

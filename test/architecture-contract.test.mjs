import assert from "node:assert/strict";
import test from "node:test";
import { discoverTools } from "../scripts/mcp-server.mjs";

test("the typed user-review operation is a routed mutation while status and graph reads stay read-only", () => {
  // lode_onboarding_review and lode_onboarding_status are actions of the grouped lode_onboarding tool (stage 3-F).
  const discovery = discoverTools({ name: "lode_onboarding_review" }, "ordinary"), onboarding = discovery.tools[0];
  assert.equal(discovery.grantsAuthorization, false);
  assert.equal(onboarding.name, "lode_onboarding");
  const action = name => onboarding.actions.find(entry => entry.action === name);
  const review = action("review");
  assert(review); assert.equal(review.invokeWith, "lode_tools_call");
  assert.equal(review.executionMode, undefined, "Product review is not worker-managed execution");
  assert.equal(action("status").invokeWith, "lode_tools_read");
  assert.equal(discoverTools({ name: "lode_project_graph" }, "ordinary").tools[0].annotations.readOnlyHint, true);
});

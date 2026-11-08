import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_EXEC_RESULT_SCHEMA, buildCodexExecWireResultSchema, verifyCodexExecWireResultSchema } from "../scripts/lib/runtime-codex-exec.mjs";
import { CODEX_FRESH_PROPOSAL_RESULT_SCHEMA, buildCodexProposalResultSchema } from "../scripts/lib/runtime-codex-proposal.mjs";
import { verifyRuntimeStructuredResult } from "../scripts/lib/runtime-invocation-lifecycle.mjs";

console.log(
  JSON.stringify({
    event: "owned-session-output-contract-tests",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);

for (const [name, build, base] of [
  ["exec", buildCodexExecWireResultSchema, CODEX_EXEC_RESULT_SCHEMA],
  ["proposal", buildCodexProposalResultSchema, CODEX_FRESH_PROPOSAL_RESULT_SCHEMA],
]) {
  test(`${name} Session wire fixes empty values without narrowing Run output or mutating its template`, () => {
    const before = structuredClone(base);
    const session = build("session"),
      run = build("run");
    assert.deepEqual(session.properties.planDelta.enum, [""]);
    assert.equal(session.properties.impactRadius.type, "array");
    assert.equal(session.properties.impactRadius.maxItems, 0);
    assert.deepEqual(session.properties.impactRadius.items, { type: "string" });
    assert.equal(verifyCodexExecWireResultSchema(session), session);
    assert.deepEqual(run, before);
    assert.deepEqual(base, before);
    const { planDelta, impactRadius, ...rest } = session.properties;
    const { planDelta: _delta, impactRadius: _impact, ...originalRest } = base.properties;
    assert.deepEqual(rest, originalRest);
    assert.deepEqual(session.required, base.required);
    assert.throws(() => build(null), { code: "INVALID_CODEX_EXEC_WIRE_SCHEMA" });
    assert.throws(() => build("unknown"), { code: "INVALID_CODEX_EXEC_WIRE_SCHEMA" });
  });
}

test("Session rejects the S42 impact counterexample and delta without normalizing response; Run preserves both", () => {
  const result = {
    schemaVersion: 1,
    kind: "RuntimeStructuredResult",
    protocolVersion: "0.1.0",
    outcome: "Proposed selected.txt update",
    evidence: ["Selected file only"],
    planDelta: "",
    impactRadius: [],
    verification: ["Synthetic local check"],
    unknowns: [],
  };
  for (const value of [result, { ...result, protocolVersion: "0.2.0", patchProposal: { proposalBasisDigest: "0".repeat(64), changes: [] } }]) {
    assert.deepEqual(verifyRuntimeStructuredResult(value, { scopeKind: "session" }), value);
    for (const change of [{ impactRadius: ["selected.txt only"] }, { planDelta: "Changed selected.txt" }, { planDelta: " ", impactRadius: [] }]) {
      const invalid = { ...value, ...change },
        bytes = JSON.stringify(invalid);
      assert.throws(() => verifyRuntimeStructuredResult(invalid, { scopeKind: "session" }), { code: "INVALID_RUNTIME_STRUCTURED_RESULT" });
      assert.equal(JSON.stringify(invalid), bytes);
      assert.deepEqual(verifyRuntimeStructuredResult(invalid, { scopeKind: "run" }), invalid);
    }
  }
});

test("wire validation permits only the needed empty array bound; existing keyword fences remain", () => {
  for (const bound of [-1, 1, "0", null]) {
    const schema = buildCodexExecWireResultSchema("session");
    schema.properties.impactRadius.maxItems = bound;
    assert.throws(() => verifyCodexExecWireResultSchema(schema), { code: "INVALID_CODEX_EXEC_WIRE_SCHEMA" });
  }
  const schema = buildCodexExecWireResultSchema("session");
  schema.properties.planDelta.maxLength = 0;
  assert.throws(() => verifyCodexExecWireResultSchema(schema), { code: "INVALID_CODEX_EXEC_WIRE_SCHEMA" });
});

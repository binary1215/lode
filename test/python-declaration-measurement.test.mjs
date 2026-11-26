import test from "node:test";
import assert from "node:assert/strict";
import { median, aggregateTrials, verifySourceResult } from "../scripts/measure-python-declarations.mjs";

test("median preserves individual values and rejects missing/nonfinite samples", () => {
  const values = [9, 1, 4];
  assert.equal(median(values), 4);
  assert.deepEqual(values, [9, 1, 4]);
  assert.equal(median([2, 4]), 3);
  assert.throws(() => median([]));
  assert.throws(() => median([1, NaN]));
});
test("aggregation keeps three trials and null local envelopes without counting unverified results", () => {
  const trials = [1, 2, 3].map((trial) => ({
    trial,
    fixture: { large: { sha256: "same" } },
    measurements: [
      { label: "query", elapsedMs: [9, 1, 4][trial - 1], structuredBytes: 100, envelopeBytes: 130, dispatchCalls: 1, verified: true },
      { label: "range", elapsedMs: 2, structuredBytes: 8, envelopeBytes: null, explicitLocalReads: 1, verified: true },
    ],
  }));
  const result = aggregateTrials(trials);
  assert.equal(result[0].medians.elapsedMs, 4);
  assert.equal(result[0].samples.length, 3);
  assert.equal(result[1].medians.envelopeBytes, null);
  assert.throws(() => aggregateTrials(trials.slice(0, 2)));
  const bad = structuredClone(trials);
  bad[1].measurements[0].verified = false;
  assert.throws(() => aggregateTrials(bad));
  const missing = structuredClone(trials);
  missing[2].measurements.pop();
  assert.throws(() => aggregateTrials(missing));
  const nonfinite = structuredClone(trials);
  nonfinite[0].measurements[0].elapsedMs = NaN;
  assert.throws(() => aggregateTrials(nonfinite));
});
test("nominal observed status cannot hide omission, missing Context or incorrect source", () => {
  const value = {
    status: "observed",
    results: [{ includedInContext: true, observationId: "obs", omittedSourceBytes: 0, reused: false }],
    context: { capsule: { evidenceGaps: [], observationEvidence: [{ nodeId: "obs", payload: { details: "whole" } }] } },
  };
  assert.equal(verifySourceResult(value, "source", "whole").exactEqual, true);
  for (const modify of [
    (v) => {
      v.results[0].omittedSourceBytes = 1;
    },
    (v) => {
      v.results[0].includedInContext = false;
    },
    (v) => {
      v.context.capsule.observationEvidence[0].payload.details = "partial";
    },
  ]) {
    const bad = structuredClone(value);
    modify(bad);
    assert.throws(() => verifySourceResult(bad, "source", "whole"));
  }
});

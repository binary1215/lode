import assert from "node:assert/strict";
import test from "node:test";
import { KIND_PAIRS, LEGACY_FORMAT, LEGACY_KINDS, LEGACY_PROTOCOLS, LEGACY_VALUES, PROTOCOL_PAIRS, VALUE_PAIRS } from "../compat/head/format.mjs";
import { familyFormatForOriginal, formatForVerifiedOwner, recordedFieldName } from "../scripts/lib/storage/project-storage-format.mjs";
import { normalizeSessionWorkEvidence } from "../scripts/lib/session/session-work-evidence-original.mjs";

// Stage 3-D follow-up: source names wire values by their Lode spelling. Each
// dialect still stores its own spelling, and either spelling selects the same value.

const lode = formatForVerifiedOwner({ storage: { dialect: "lode", directory: ".lode" } });
const tables = [
  ["protocol", PROTOCOL_PAIRS, LEGACY_PROTOCOLS],
  ["kind", KIND_PAIRS, LEGACY_KINDS],
  ["value", VALUE_PAIRS, LEGACY_VALUES],
];

test("each dialect stores its own spelling whichever spelling the source names", () => {
  for (const [method, pairs, inverse] of tables) {
    assert.equal(Object.keys(inverse).length, Object.keys(pairs).length, `${method} pairs are one to one`);
    for (const [legacy, canonical] of Object.entries(pairs)) {
      assert.equal(inverse[canonical], legacy);
      for (const named of [legacy, canonical]) {
        assert.equal(lode[method](named), canonical);
        assert.equal(LEGACY_FORMAT[method](named), legacy);
      }
    }
  }
  assert.equal(LEGACY_FORMAT.protocol("not-a-registered-protocol"), "not-a-registered-protocol");
});

test("a protocol family named by either spelling selects the record's own dialect", () => {
  const [legacy, canonical] = Object.entries(PROTOCOL_PAIRS)[0];
  for (const family of [legacy, canonical]) {
    assert.equal(familyFormatForOriginal(family, { protocol: { name: legacy } }), LEGACY_FORMAT);
    assert.equal(familyFormatForOriginal(family, { protocol: { name: canonical } }).dialect, "lode");
    assert.equal(familyFormatForOriginal(family, { protocol: { name: "other" } }), null);
  }
  for (const kind of ["HeadSession", "LodeSession"]) {
    assert.equal(familyFormatForOriginal({ kind }, { kind: "LodeSession" }).dialect, "lode");
    assert.equal(familyFormatForOriginal({ kind }, { kind: "HeadSession" }), LEGACY_FORMAT);
  }
});

test("renamed record fields and values keep their historical spelling in .head and in older records", () => {
  for (const [legacy, canonical] of [
    ["freshHeadReviewRequired", "freshLodeReviewRequired"],
    ["curated-head-canon", "curated-lode-canon"],
    ["curated-head-canon-only", "curated-lode-canon-only"],
    ["head-proposed", "lode-proposed"],
  ]) {
    assert.equal(lode.value(canonical), canonical);
    assert.equal(LEGACY_FORMAT.value(canonical), legacy);
  }
  const field = "freshLodeReviewRequired";
  assert.equal(recordedFieldName({ freshLodeReviewRequired: true }, field), field);
  assert.equal(recordedFieldName({ freshHeadReviewRequired: true }, field), "freshHeadReviewRequired");
  assert.equal(recordedFieldName({ freshHeadReviewRequired: true, freshLodeReviewRequired: true }, field), field);
  assert.equal(recordedFieldName(null, field), field);
});

test("a Todo origin is accepted in either spelling and kept as recorded", () => {
  for (const origin of ["lode-proposed", "head-proposed", "user-directed"]) {
    const content = normalizeSessionWorkEvidence({ todos: [{ todoId: "todo-a", task: "Task", status: "completed", origin }] });
    assert.equal(content.todos[0].origin, origin);
  }
  assert.throws(() => normalizeSessionWorkEvidence({ todos: [{ todoId: "todo-a", task: "Task", status: "completed", origin: "agent-proposed" }] }));
});

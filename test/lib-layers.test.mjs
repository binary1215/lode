import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { BASELINE_FILE, layerPath, layerState, libImportGraph, placementProblems, readLayerTable } from "../scripts/lib-layer-baseline.mjs";

// The scripts/lib layer rule (scripts/lib-layers.json, lowest layer first): a
// module may import its own layer or a lower one. The imports that point upward
// today, static and dynamic, are recorded in test/fixtures/lib-layer-baseline.json
// and may only shrink. There is no static import cycle, and none may appear.

const table = readLayerTable();
const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
const difference = (now, recorded) => ({ added: now.filter((entry) => !recorded.includes(entry)), removed: recorded.filter((entry) => !now.includes(entry)) });

test("every scripts/lib file is in the directory of its layer, and the table lists exactly those files", () => {
  assert.deepEqual(table.order, ["core", "storage", "world", "session", "runtime", "worker", "distribution"]);
  assert.deepEqual(placementProblems(table), []);
  // Pinned files keep their scripts/lib path; everything else sits in its layer.
  for (const name of table.pinned) assert.equal(layerPath(name, table), name);
  assert.equal(layerPath("world-model.mjs", table), "world/world-model.mjs");
});

test("no new upward static import, and every recorded one still exists (the list only shrinks)", () => {
  const { added, removed } = difference(layerState(table).staticUpward, baseline.staticUpward);
  assert.deepEqual(added, [], "A module imports a higher layer. Import a lower layer, or move the shared code down.");
  assert.deepEqual(removed, [], "A recorded upward import is gone. Run `node scripts/lib-layer-baseline.mjs --write` to shrink the list.");
});

test("no new upward dynamic import, and every recorded one still exists (the list only shrinks)", () => {
  const { added, removed } = difference(layerState(table).dynamicUpward, baseline.dynamicUpward);
  assert.deepEqual(added, [], "A module dynamically imports a higher layer.");
  assert.deepEqual(removed, [], "A recorded upward dynamic import is gone. Run `node scripts/lib-layer-baseline.mjs --write` to shrink the list.");
});

test("scripts/lib has no static import cycle", () => {
  assert.deepEqual(baseline.staticCycles, []);
  assert.deepEqual(layerState(table).staticCycles, []);
});

test("the rule sees a new upward import, a new cycle and a stale entry", () => {
  const graph = libImportGraph();
  const add = (from, to) => {
    const copy = new Map([...graph].map(([file, edges]) => [file, { static: [...edges.static], dynamic: [...edges.dynamic] }]));
    copy.get(from).static.push(to);
    return copy;
  };
  // core importing world is upward.
  assert.ok(layerState(table, add("core/digest.mjs", "world/world-model.mjs")).staticUpward.includes("core/digest.mjs -> world/world-model.mjs"));
  // A static cycle is reported even inside one layer.
  const cyclic = add("core/digest.mjs", "core/errors.mjs");
  cyclic.get("core/errors.mjs").static.push("core/digest.mjs");
  assert.deepEqual(layerState(table, cyclic).staticCycles, ["core/digest.mjs <-> core/errors.mjs"]);
  // A recorded entry missing from the tree is reported as removed.
  assert.deepEqual(difference([], ["a -> b"]).removed, ["a -> b"]);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../scripts/graph-explorer/exploration.js", import.meta.url), "utf8");

test("overview viewport geometry preserves crossing, parallel and self edges, excludes offscreen segments and invalidates after a move", () => {
  const factory = vm.runInNewContext(source + "\nexplorerModel"), graph = { nodes: ["a", "b", "c", "d"].map(nodeId => ({ nodeId })), edges: [
    { from: "a", to: "b", id: "cross" }, { from: "b", to: "a", id: "reverse" }, { from: "c", to: "d", id: "outside" }, { from: "a", to: "a", id: "self" }] };
  const overview = factory.overview(graph);
  overview.move("a", -1000, 350); overview.move("b", 2000, 350); overview.move("c", -100, -100); overview.move("d", -200, -200);
  const view = overview.window([0, 0, 1000, 700]); assert.deepEqual([...view.edges].map(edge => edge.id).sort(), ["cross", "reverse"]); assert.equal(view.nodes.length, 0);
  assert.equal(graph.edges.length, 4); overview.move("a", 500, 350);
  assert.deepEqual([...overview.window([0, 0, 1000, 700]).edges].map(edge => edge.id).sort(), ["cross", "reverse", "self"]);
  assert.deepEqual([...overview.window([0, 0, 1000, 700]).nodes], ["a"]);
  const whole = [-2000, -2000, 5000, 4000]; overview.window(whole);
  const get = overview.points.get.bind(overview.points); let reads = 0;
  overview.points.get = id => { reads++; return get(id); };
  const all = overview.window(whole); assert.equal(all.nodes.length, 4); assert.equal(all.edges.length, 4);
  assert.equal(reads, 0, "A cached whole-bounds view must not redo every node/edge clipping lookup");
});

test("bulk placement yields on occupied candidate attempts before even the first new record completes", async () => {
  const factory = vm.runInNewContext(source + "\nexplorerModel"), ids = Array.from({ length: 1026 }, (_, i) => `crowded-${i}`);
  const model = factory.create({ nodes: ids.map(nodeId => ({ nodeId })), edges: [] });
  model.choose(ids[0]); await model.placeBatch(ids.slice(1, -1));
  const before = JSON.stringify([...model.positions]); let stop = false, yields = 0;
  const applied = await model.placeBatch([ids.at(-1)], { cancelled: () => stop, yieldWork: async () => { stop = true; yields++; } });
  assert.equal(applied, false); assert(yields > 0); assert.equal(JSON.stringify([...model.positions]), before);
});

test("first-screen placement budgets do not limit expansion evidence or later explicit placement", async () => {
  const factory = vm.runInNewContext(source + "\nexplorerModel"), nodes = Array.from({ length: 1001 }, (_, i) => ({ nodeId: `n${i}` }));
  const graph = { nodes, edges: nodes.slice(1).map(node => ({ from: "n0", to: node.nodeId, type: "LINK" })) }, model = factory.create(graph);
  model.choose("n0"); const result = await model.expandWave({ placementLimit: 8 });
  assert.equal(result.added, 1000); assert.equal(result.edges, 1000); assert.equal(model.visible.size, 1001); assert.equal(model.positions.size, 9);
  assert.equal(model.search("n1000").length, 1); model.choose("n1000"); assert(model.positions.has("n1000"));
  await model.placeBatch(model.visible); assert.equal(model.positions.size, 1001);
});

test("all 60000 metadata IDs stay searchable while layout measures only explored neighbors", () => {
  const factory = vm.runInNewContext(source + "\nexplorerModel");
  const nodes = Array.from({ length: 60000 }, (_, i) => ({ nodeId: `generic-${i}`, kind: "File", path: `src/generic-${i}.mjs` }));
  const graph = { nodes, edges: nodes.flatMap((node, i) => [{ edgeId: `e${i}`, from: nodes[(i + 1) % nodes.length].nodeId, to: node.nodeId, type: "IMPORTS" },
    { edgeId: `c${i}`, from: nodes[(i + 2) % nodes.length].nodeId, to: node.nodeId, type: "CALLS" }]) };
  let measurements = 0;
  const model = factory.create(graph, () => "code", () => { measurements++; return { left: 155, right: 155, top: 44, bottom: 84 }; });
  assert.equal(model.nodes.size, 60000); assert.equal(graph.edges.length, 120000); assert.equal(measurements, 0);
  const cards = vm.runInNewContext(fs.readFileSync(new URL("../scripts/graph-explorer/cards.js", import.meta.url), "utf8") + "\nexplorerCards");
  let bodyReads = 0; for (const node of nodes) Object.defineProperty(node, "workContent", { get() { bodyReads++; return { summary: "Recorded only" }; } });
  const index = cards.create({ project: { projectId: "scale-fixture" } }, graph, "code"); assert.equal(bodyReads, 0, "Group/index construction must not read every body");
  const description = index.describe(nodes[0]); assert(bodyReads > 0 && bodyReads < 10);
  assert.equal(description.body, "Recorded only");
  const reads = bodyReads;
  assert.equal(index.describe(nodes[0]), description);
  assert.equal(bodyReads, reads, "Reading the same card reuses its exact description");
  for (const id of ["generic-64", "generic-500", "generic-59999"]) {
    assert(model.search(`"${id}"`).some(node => node.nodeId === id)); assert(model.visit(id));
  }
  assert(measurements < 20); assert.equal(model.nodes.size, 60000);
});

test("batch placement and changed-size adjustment commit atomically, retaining pins and unrelated coordinates on cancel or drift", async () => {
  const factory = vm.runInNewContext(source + "\nexplorerModel"), ids = Array.from({ length: 700 }, (_, i) => `N${i}`);
  let enlarged = false;
  const model = factory.create({ nodes: ids.map(nodeId => ({ nodeId })), edges: [] }, () => "code", node => {
    const size = enlarged && node.nodeId !== "N699" ? 120 : 40; return { left: size, right: size, top: size, bottom: size };
  });
  model.choose("N0"); model.choose("N699"); const baseline = JSON.stringify([...model.positions]); let yields = 0, stop = false;
  assert.equal(await model.placeBatch(ids, { cancelled: () => stop, yieldWork: async () => { if (++yields === 23) stop = true; } }), false);
  assert.equal(JSON.stringify([...model.positions]), baseline, "Cancel during positioning cannot leak staged coordinates"); assert.equal(yields, 23);
  assert.equal(await model.placeBatch(ids), true); model.move("N0", 500, 350); model.move("N1", 500, 350);
  const before = JSON.stringify([...model.positions]), oldExtents = JSON.stringify(ids.map(id => model.extent(id))), unaffected = { ...model.positions.get("N699") };
  enlarged = true; stop = false; yields = 0;
  assert.equal(await model.remeasure(ids, { cancelled: () => stop, yieldWork: async () => { if (++yields === 22) stop = true; } }), false);
  assert.equal(yields, 22, "Cancel after measurement and some staged position correction");
  assert.equal(JSON.stringify([...model.positions]), before); assert.equal(JSON.stringify(ids.map(id => model.extent(id))), oldExtents);
  assert.equal(await model.remeasure(ids), true);
  for (const id of ["N0", "N1"]) assert.deepEqual({ ...model.positions.get(id) }, { x: 500, y: 350 }, "Intentional overlapping pins remain pinned");
  assert.deepEqual({ ...model.positions.get("N699") }, unaffected);
  for (let i = 2; i < ids.length; i++) for (let j = 0; j < i; j++) {
    const a = model.positions.get(ids[i]), b = model.positions.get(ids[j]), ae = model.extent(ids[i]), be = model.extent(ids[j]);
    assert(!(a.x - ae.left < b.x + be.right && a.x + ae.right > b.x - be.left && a.y - ae.top < b.y + be.bottom && a.y + ae.bottom > b.y - be.top), `${ids[i]}/${ids[j]}`);
  }
  const clean = factory.create({ nodes: ids.map(nodeId => ({ nodeId })), edges: [] }); clean.choose("N0"); let moved = false;
  assert.equal(await clean.placeBatch(ids, { yieldWork: async () => { if (!moved) { moved = true; clean.move("N0", 12, 34); } } }), false);
  assert.equal(clean.positions.size, 1); assert.deepEqual({ ...clean.positions.get("N0") }, { x: 12, y: 34 });
});

test("1000 direct neighbors remain reachable and disjoint without an all-inventory scan for each placement", () => {
  const factory = vm.runInNewContext(source + "\nexplorerModel");
  const nodes = Array.from({ length: 1001 }, (_, i) => ({ nodeId: String(i), kind: i % 2 ? "File" : "Feature" }));
  const graph = { nodes, edges: nodes.slice(1).map(node => ({ from: "0", to: node.nodeId, type: "LINK" })) };
  const model = factory.create(graph, node => node.kind === "File" ? "code" : "context");
  assert(model.visit("0")); assert.equal(model.visible.size, nodes.length); assert.equal(model.neighbors("0").length, 1000);
  const retained = [...model.positions].map(([id, point]) => [id, { ...point }]);
  for (let a = 0; a < retained.length; a++) for (let b = a + 1; b < retained.length; b++) {
    const p = retained[a][1], q = retained[b][1];
    assert(!(p.x - 155 < q.x + 155 && p.x + 155 > q.x - 155 && p.y - 44 < q.y + 84 && p.y + 84 > q.y - 44));
  }
  model.visit("1");
  for (const [id, point] of retained) assert.deepEqual({ ...model.positions.get(id) }, point);
});

test("group redraw visits only visible memberships and matches the complete reference geometry without scanning hidden members", t => {
  const cards = vm.runInNewContext(fs.readFileSync(new URL("../scripts/graph-explorer/cards.js", import.meta.url), "utf8") + "\nexplorerCards");
  const count = 60000, groups = new Map(), memberships = new Map();
  for (let i = 0; i < count; i++) {
    const key = `G${i}`, root = `N${i}`, member = `N${(i + 1) % count}`, other = `N${(i + 2) % count}`;
    groups.set(key, { key, order: i, rootId: root, members: new Set([root, member, other]) });
    for (const id of [root, member, other]) { if (!memberships.has(id)) memberships.set(id, new Set()); memberships.get(id).add(key); }
  }
  const points = new Map(Array.from({ length: 12 }, (_, i) => [`N${i}`, { left: i * 200, right: i * 200 + 100, top: 0, bottom: 100 }]));
  const reference = [];
  for (const group of groups.values()) {
    const shown = [...group.members].filter(id => points.has(id)); if (!shown.length) continue;
    const r = shown.map(id => points.get(id)), box = { left: Math.min(...r.map(item => item.left)) - 18, right: Math.max(...r.map(item => item.right)) + 18,
      top: Math.min(...r.map(item => item.top)) - 35, bottom: Math.max(...r.map(item => item.bottom)) + 18 };
    reference.push({ key: group.key, box, shown: shown.length, exported: group.members.size,
      enclosure: !shown.some(id => memberships.get(id).size > 1) && ![...points].some(([id, r]) => !group.members.has(id) && cards.intersects(box, r)) });
  }
  let gets = 0;
  const lookupOnly = { get(key) { gets++; return groups.get(key); }, values() { throw Error("Full group scan on camera redraw"); }, [Symbol.iterator]() { throw Error("Full group scan"); } };
  for (const group of groups.values()) group.members[Symbol.iterator] = () => { throw Error("Full member scan on camera redraw"); };
  const actual = cards.groupGeometry(lookupOnly, memberships, points).map(({ key, box, shown, exported, enclosure }) => ({ key, box, shown, exported, enclosure }));
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), reference); assert.equal(actual.length, 14); assert.equal(gets, 36);
  t.diagnostic("Pure geometry work-count/equivalence counterexample: 60000 groups, 180000 root-inclusive memberships, 12 visible rectangles. Not browser timing or pan acceptance.");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { explorerCodec } from "../scripts/graph-explorer/codec.js";
const throughJson = (value) => JSON.parse(JSON.stringify(value));

test("offline table transport preserves every JSON value, identity, array multiplicity and independent edge occurrence", () => {
  const edge = { from: "a", to: "b", type: "SAME", source: { digest: "a".repeat(64), freshness: "historical" } };
  const original = {
    nodes: [
      { nodeId: "a", projectId: "one", revisionId: "old", label: "한글 😀 </script> \u001b\u202e" },
      { nodeId: "b", projectId: "two", revisionId: "new" },
    ],
    edges: [edge, edge],
    zero: 0,
    false: false,
    empty: "",
    missing: null,
    optional: undefined,
    array: [undefined, null, "a", 0, -1, -0.5, -1e30, ["n", -2]],
    future: JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"unsafe":true}}}'),
  };
  const before = JSON.stringify(original),
    decoded = explorerCodec.decode(throughJson(explorerCodec.encode(original)));
  assert.deepEqual(decoded, throughJson(original));
  assert.equal(JSON.stringify(original), before);
  assert.notEqual(decoded.edges[0], decoded.edges[1]);
  assert.notEqual(decoded.edges[0].source, decoded.edges[1].source);
  assert(Object.hasOwn(decoded.future, "__proto__"));
  assert.equal({}.polluted, undefined);
  assert.equal({}.unsafe, undefined);
});

test("repeated metadata is interned losslessly without dropping producer, provenance or unknown fields", (t) => {
  const producer = { descriptor: "generic-producer-".repeat(80), version: "1", nested: { authority: false, future: ["unknown", null] } };
  const input = { nodes: Array.from({ length: 2000 }, (_, i) => ({ nodeId: `n${i}`, producer, provenance: { root: "same-root", digest: "b".repeat(64) } })) };
  const encoded = throughJson(explorerCodec.encode(input));
  assert.deepEqual(explorerCodec.decode(encoded), input);
  const plainBytes = Buffer.byteLength(JSON.stringify(input)),
    encodedBytes = Buffer.byteLength(JSON.stringify(encoded));
  assert(encodedBytes < plainBytes / 2);
  t.diagnostic(JSON.stringify({ plainBytes, encodedBytes, scope: "Synthetic repeated-metadata transport, not GUI performance" }));
});

test("the exact browser-bundled codec roundtrips identically and rejects forged references, cycles and duplicate keys", () => {
  const source = fs
    .readFileSync(new URL("../scripts/graph-explorer/codec.js", import.meta.url), "utf8")
    .replace(/^export const explorerCodec =/m, "const explorerCodec =");
  const browser = vm.runInNewContext(source + "\nexplorerCodec");
  const input = { direction: "a→b", relation: { state: "rejected", pending: ["unknown"] }, values: [0, false, "", null] };
  assert.equal(JSON.stringify(browser.decode(throughJson(explorerCodec.encode(input)))), JSON.stringify(input));
  for (const bad of [
    { strings: [], schemas: [], objects: [], arrays: [], root: -1 },
    { strings: [], schemas: [], objects: [], arrays: [[-3]], root: -3 },
    { strings: ["key"], schemas: [[0, 0]], objects: [[0, null, true]], arrays: [], root: -2 },
  ])
    assert.throws(() => browser.decode({ encoding: "lode-explorer-json-table-v3", ...bad }), /GRAPH_EXPLORER_INVALID_DATA_TABLE/);
});

import crypto from "node:crypto";
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const fail = () => {
  throw Object.assign(new Error("Invalid chunked code bucket/index."), { code: "INVALID_SNAPSHOT_CODE_CHUNKS" });
};
const shape = (value, keys) =>
  value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const SPECS = {
  world: { files: "world.files", semanticNodes: "world.semanticNodes", semanticEdges: "world.semanticEdges" },
  graph: { nodes: "graph.nodes", edges: "graph.edges" },
};
const bucketFor = (key) => parseInt(hash(String(key)).slice(0, 8), 16) % 64;
function split(group, arrays, keyFor, body, put) {
  const specs = SPECS[group],
    keys = Object.keys(specs),
    buckets = new Map(),
    lists = {};
  for (const key of keys) {
    const rows = arrays[key];
    if (!Array.isArray(rows)) fail();
    const order = [];
    for (const row of rows) {
      const bucket = bucketFor(keyFor[key](row));
      order.push(bucket);
      if (!buckets.has(bucket)) buckets.set(bucket, Object.fromEntries(keys.map((key) => [key, []])));
      buckets.get(bucket)[key].push(row);
    }
    lists[key] = { family: specs[key], order };
  }
  const chunks = [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([bucket, lists]) => ({
      bucket,
      counts: Object.fromEntries(keys.map((key) => [key, lists[key].length])),
      ref: put("code-bucket-chunk", { group, bucket, lists }),
    }));
  return { ...(group === "world" ? { body } : {}), lists, chunks };
}
function validateIndex(group, payload) {
  const specs = SPECS[group],
    keys = Object.keys(specs);
  if (
    !shape(payload, group === "world" ? ["body", "lists", "chunks"] : ["lists", "chunks"]) ||
    !shape(payload.lists, keys) ||
    !Array.isArray(payload.chunks) ||
    payload.chunks.length > 64
  )
    fail();
  if (
    group === "world" &&
    (!payload.body ||
      typeof payload.body !== "object" ||
      Array.isArray(payload.body) ||
      payload.body.files !== null ||
      !payload.body.semanticGraph ||
      Array.isArray(payload.body.semanticGraph) ||
      payload.body.semanticGraph.nodes !== null ||
      payload.body.semanticGraph.edges !== null)
  )
    fail();
  for (const key of keys)
    if (!shape(payload.lists[key], ["family", "order"]) || payload.lists[key].family !== specs[key] || !Array.isArray(payload.lists[key].order)) fail();
  const buckets = new Map(),
    addresses = new Set();
  let previous = -1;
  for (const descriptor of payload.chunks) {
    if (
      !shape(descriptor, ["bucket", "counts", "ref"]) ||
      !Number.isInteger(descriptor.bucket) ||
      descriptor.bucket < 0 ||
      descriptor.bucket >= 64 ||
      descriptor.bucket <= previous ||
      !shape(descriptor.counts, keys) ||
      descriptor.ref?.domain !== "code-bucket-chunk" ||
      typeof descriptor.ref.address !== "string" ||
      addresses.has(descriptor.ref.address)
    )
      fail();
    if (
      keys.some(
        (key) => !Number.isSafeInteger(descriptor.counts[key]) || descriptor.counts[key] < 0 || descriptor.counts[key] > payload.lists[key].order.length,
      ) ||
      keys.every((key) => descriptor.counts[key] === 0)
    )
      fail();
    previous = descriptor.bucket;
    addresses.add(descriptor.ref.address);
    buckets.set(descriptor.bucket, descriptor);
  }
  for (const key of keys) {
    const counts = new Map();
    for (const bucket of payload.lists[key].order) {
      if (!Number.isInteger(bucket) || !buckets.has(bucket)) fail();
      const n = (counts.get(bucket) || 0) + 1;
      if (n > buckets.get(bucket).counts[key]) fail();
      counts.set(bucket, n);
    }
    if ([...buckets].some(([bucket, descriptor]) => (counts.get(bucket) || 0) !== descriptor.counts[key])) fail();
  }
  return buckets;
}
export function snapshotCodeBucketSummary(payload) {
  if (
    !shape(payload, ["group", "bucket", "lists"]) ||
    typeof payload.group !== "string" ||
    !Object.hasOwn(SPECS, payload.group) ||
    !Number.isInteger(payload.bucket) ||
    payload.bucket < 0 ||
    payload.bucket >= 64
  )
    fail();
  const keys = Object.keys(SPECS[payload.group]);
  if (!shape(payload.lists, keys) || keys.some((key) => !Array.isArray(payload.lists[key]))) fail();
  const counts = Object.fromEntries(keys.map((key) => [key, payload.lists[key].length]));
  if (keys.every((key) => counts[key] === 0)) fail();
  return { group: payload.group, bucket: payload.bucket, counts };
}
function join(group, payload, read) {
  const descriptors = validateIndex(group, payload),
    keys = Object.keys(SPECS[group]),
    leaves = new Map();
  for (const [bucket, descriptor] of descriptors) {
    const leaf = read(descriptor.ref),
      summary = snapshotCodeBucketSummary(leaf);
    if (summary.group !== group || summary.bucket !== bucket || keys.some((key) => summary.counts[key] !== descriptor.counts[key])) fail();
    leaves.set(bucket, leaf.lists);
  }
  const arrays = {};
  for (const key of keys) {
    const offsets = new Map();
    arrays[key] = payload.lists[key].order.map((bucket) => {
      const rows = leaves.get(bucket)[key],
        offset = offsets.get(bucket) || 0;
      if (offset >= rows.length) fail();
      offsets.set(bucket, offset + 1);
      return rows[offset];
    });
    if ([...descriptors].some(([bucket, descriptor]) => (offsets.get(bucket) || 0) !== descriptor.counts[key])) fail();
  }
  return arrays;
}
export function splitWorldCodeChunks(payload, put) {
  const nodes = new Map(payload.semanticGraph.nodes.map((node) => [node.id, node]));
  return split(
    "world",
    { files: payload.files, semanticNodes: payload.semanticGraph.nodes, semanticEdges: payload.semanticGraph.edges },
    {
      files: (row) => row.path,
      semanticNodes: (row) => row.path ?? row.id,
      semanticEdges: (row) => nodes.get(row.from)?.path ?? row.from ?? row.id,
    },
    { ...payload, files: null, semanticGraph: { ...payload.semanticGraph, nodes: null, edges: null } },
    put,
  );
}
export function joinWorldCodeChunks(payload, read) {
  const arrays = join("world", payload, read);
  return { ...payload.body, files: arrays.files, semanticGraph: { ...payload.body.semanticGraph, nodes: arrays.semanticNodes, edges: arrays.semanticEdges } };
}
export function splitGraphCodeChunks(payload, put) {
  const nodes = new Map(payload.nodes.map((row) => [row.body.nodeId, row.body]));
  return split(
    "graph",
    payload,
    {
      nodes: (row) => row.body.path ?? row.body.logicalEntityId ?? row.body.nodeId,
      edges: (row) => nodes.get(row.body.from)?.path ?? row.body.from ?? row.body.edgeId,
    },
    null,
    put,
  );
}
export function joinGraphCodeChunks(payload, read) {
  return join("graph", payload, read);
}
// GC retains bounded descriptors/counts, never decoded rows. The very same
// index grammar and per-family cardinality checks apply before dependency use.
export function snapshotCodeChunkDescriptors(domain, payload) {
  const group = domain === "world-code-chunks" ? "world" : domain === "graph-code-chunks" ? "graph" : null;
  if (!group) fail();
  return [...validateIndex(group, payload).values()].map((descriptor) => ({ ...descriptor, group }));
}

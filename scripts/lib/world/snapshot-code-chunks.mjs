import { sha256Hex as hash } from "../core/digest.mjs";
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
    .map(([bucket, bucketLists]) => {
      const counts = Object.fromEntries(keys.map((key) => [key, bucketLists[key].length]));
      if (!put.fileParts) return { bucket, counts, ref: put("code-bucket-chunk", { group, bucket, lists: bucketLists }) };
      // One content-addressed part per path. Unchanged paths keep their bytes.
      // `sequence` restores the original interleaved row order.
      const parts = [];
      const partIndex = new Map();
      const sequence = {};
      for (const key of keys) {
        sequence[key] = [];
        for (const row of bucketLists[key]) {
          const pathKey = String(keyFor[key](row));
          const id = key + "\0" + pathKey;
          let index = partIndex.get(id);
          if (index === undefined) {
            index = parts.length;
            partIndex.set(id, index);
            parts.push({ family: key, path: pathKey, rows: [] });
          }
          parts[index].rows.push(row);
          sequence[key].push(index);
        }
      }
      const storedParts = parts.map((part) => ({
        family: part.family,
        path: part.path,
        count: part.rows.length,
        ref: put("code-file-part", { group, bucket, family: part.family, path: part.path, rows: part.rows }),
      }));
      return { bucket, counts, ref: put("code-bucket-chunk", { group, bucket, parts: storedParts, sequence }) };
    });
  return { ...(group === "world" ? { body } : {}), lists, chunks };
}
function materializeLeaf(leaf, read) {
  if (!leaf || typeof leaf !== "object" || Array.isArray(leaf)) fail();
  if (leaf.lists) return leaf;
  if (!shape(leaf, ["group", "bucket", "parts", "sequence"]) || !Array.isArray(leaf.parts)) fail();
  const keys = Object.keys(SPECS[leaf.group] || {});
  if (!keys.length || !shape(leaf.sequence, keys)) fail();
  const loaded = leaf.parts.map((part) => {
    if (!part || part.ref?.domain !== "code-file-part" || !Number.isSafeInteger(part.count) || part.count < 1 || !keys.includes(part.family)) fail();
    const body = read(part.ref);
    if (
      !shape(body, ["group", "bucket", "family", "path", "rows"]) ||
      body.group !== leaf.group ||
      body.bucket !== leaf.bucket ||
      body.family !== part.family ||
      body.path !== part.path ||
      !Array.isArray(body.rows) ||
      body.rows.length !== part.count
    )
      fail();
    return body.rows;
  });
  const lists = {};
  for (const key of keys) {
    if (!Array.isArray(leaf.sequence[key])) fail();
    const cursors = new Map();
    lists[key] = leaf.sequence[key].map((index) => {
      const part = leaf.parts[index];
      if (!part || part.family !== key) fail();
      const offset = cursors.get(index) || 0;
      const row = loaded[index][offset];
      if (row === undefined) fail();
      cursors.set(index, offset + 1);
      return row;
    });
    if ([...cursors].some(([index, offset]) => offset !== leaf.parts[index].count)) fail();
  }
  return { ...leaf, lists };
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
    !payload ||
    typeof payload.group !== "string" ||
    !Object.hasOwn(SPECS, payload.group) ||
    !Number.isInteger(payload.bucket) ||
    payload.bucket < 0 ||
    payload.bucket >= 64
  )
    fail();
  const keys = Object.keys(SPECS[payload.group]);
  const listed = shape(payload, ["group", "bucket", "lists"]);
  const parted = shape(payload, ["group", "bucket", "parts", "sequence"]);
  if (!listed && !parted) fail();
  if (listed && (!shape(payload.lists, keys) || keys.some((key) => !Array.isArray(payload.lists[key])))) fail();
  if (parted && (!shape(payload.sequence, keys) || !Array.isArray(payload.parts) || keys.some((key) => !Array.isArray(payload.sequence[key])))) fail();
  const counts = Object.fromEntries(keys.map((key) => [key, (listed ? payload.lists : payload.sequence)[key].length]));
  if (keys.every((key) => counts[key] === 0)) fail();
  return { group: payload.group, bucket: payload.bucket, counts };
}
function join(group, payload, read) {
  const descriptors = validateIndex(group, payload),
    keys = Object.keys(SPECS[group]),
    leaves = new Map();
  for (const [bucket, descriptor] of descriptors) {
    const raw = read(descriptor.ref),
      summary = snapshotCodeBucketSummary(raw),
      leaf = materializeLeaf(raw, read);
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

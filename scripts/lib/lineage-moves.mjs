// Request-local k-way merge over exact-content groups. Counts stay exact,
// while candidate generation follows only the requested canonical sorted page.
export function boundedPossibleMoves(beforeFiles, afterFiles, limit, page = null) {
  const before = new Map(beforeFiles.map(file => [file.path, file.digest]));
  const after = new Map(afterFiles.map(file => [file.path, file.digest]));
  const groups = new Map();
  for (const [path, digest] of after) if (!before.has(path)) {
    if (!groups.has(digest)) groups.set(digest, { targets: [], rows: [] });
    const group = groups.get(digest);
    group.targets.push({ path, quoted: JSON.stringify(path), ordinal: group.targets.length });
  }
  const prefixFor = (fromPath, digest) => JSON.stringify({ automaticSameAsRelation: false,
    classification: "exact-content-possible-move", digest, fromPath,
    reviewRequiredOnlyForSemanticPromotion: true, semanticContinuityClaimed: false }).slice(0, -1) + ',"toPath":';
  const compare = (a, b) => a.key.localeCompare(b.key) || a.ordinal - b.ordinal;
  let count = 0, eligibleCount = 0;
  for (const [fromPath, digest] of before) if (!after.has(fromPath) && groups.has(digest)) {
    const group = groups.get(digest);
    group.rows.push({ fromPath, digest, prefix: prefixFor(fromPath, digest), ordinal: count });
    count += group.targets.length;
  }
  const heap = [];
  const candidate = (row, targets, index) => ({ key: row.prefix + targets[index].quoted + "}",
    ordinal: row.ordinal + targets[index].ordinal, row, targets, index });
  function push(value) {
    heap.push(value); let i = heap.length - 1;
    while (i > 0) { const p = Math.floor((i - 1) / 2); if (compare(heap[p], heap[i]) <= 0) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  }
  function pop() {
    const first = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let i = 0;
      while (2 * i + 1 < heap.length) { let c = 2 * i + 1;
        if (c + 1 < heap.length && compare(heap[c + 1], heap[c]) < 0) c++;
        if (compare(heap[i], heap[c]) <= 0) break;
        [heap[i], heap[c]] = [heap[c], heap[i]]; i = c; } }
    return first;
  }
  for (const { targets, rows } of groups.values()) {
    if (!rows.length) continue;
    // Only toPath varies inside a row, following the same fixed JSON field
    // suffix in every row. Sort this column once with the complete canonical
    // key and original input ordinal, then merge rows using their actual keys.
    const prefix = rows[0].prefix;
    targets.sort((a, b) => (prefix + a.quoted + "}").localeCompare(prefix + b.quoted + "}") || a.ordinal - b.ordinal);
    for (const row of rows) {
      let low = 0, high = targets.length;
      if (page?.after) while (low < high) { const middle = Math.floor((low + high) / 2);
        if (compare(candidate(row, targets, middle), page.after) <= 0) low = middle + 1; else high = middle; }
      eligibleCount += targets.length - low;
      if (low < targets.length) push(candidate(row, targets, low));
    }
  }
  const selected = [];
  while (heap.length && selected.length < limit) { const value = pop(); selected.push(value);
    if (value.index + 1 < value.targets.length) push(candidate(value.row, value.targets, value.index + 1)); }
  const last = selected.at(-1);
  return { count, items: selected.map(({ row, targets, index }) => ({ fromPath: row.fromPath, toPath: targets[index].path,
    digest: row.digest, classification: "exact-content-possible-move", semanticContinuityClaimed: false,
    automaticSameAsRelation: false, reviewRequiredOnlyForSemanticPromotion: true })), omittedCount: count - selected.length,
    ...(page ? { remainingCount: eligibleCount - selected.length, endAfter: last ? { key: last.key, ordinal: last.ordinal } : page.after || null } : {}) };
}

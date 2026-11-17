// Reading the product graph one step at a time: the walk (down, up, reach,
// find, paging) and its text, used by product-graph-query and by the offline
// page, so both say the same thing for the same question. It also renders the
// parts of check.txt the page shows (limits, guide, the six checks, the lists,
// the comparison with the baseline), so those numbers and words are the
// build's own. Pure functions over graph.json / check.json values: no file,
// clock or network access. Words are the original product graph's, in Korean,
// whatever language the page frame uses.
export const productGraphWalk = (() => {
  const LIMIT = 50;
  const LIST_LIMIT = 50;
  const CODE_EDGES = new Set(["call", "callback"]);
  const CHANGE_WORDS = Object.freeze({ changed: "변경", added: "신규", removed: "사라짐", reach: "닿는 코드가 바뀜", reached: "새로 닿음", unreached: "닿지 않게 됨" });
  // Confirmation records (independent of the baseline).
  const CHECK_WORDS = Object.freeze({
    neverChecked: "확인한 적 없음",
    changedSinceCheck: "확인 뒤 코드가 바뀜",
    textChanged: "확인 뒤 글이 바뀜",
    otherReader: "다른 방식으로 읽은 때 확인함",
    issues: "읽지 못한 확인 기록",
  });
  const CHECK_BY = Object.freeze({ "agent-checked": "에이전트 확인", "user-approved": "사용자 승인" });
  const CHECK_NODE_WORDS = Object.freeze({ changed: "내용이 바뀜", reachChanged: "닿는 코드가 바뀜", removed: "사라짐", unhashed: "내용 해시 없음" });
  // The build's own words, shared with the page so it never retypes them.
  const WORDS = Object.freeze({
    guide: "처음 쓸 때 — 빠진 입력",
    checks: "제품 그래프 정합성 검사",
    comparison: "기준과 비교",
    confirmations: "확인 기록 (기준과 따로: 기준을 옮겨도 지워지지 않는다)",
    unchecked: "검사 못 함",
    noFindings: "0건",
    findings: (count) => `${count}건`,
    groupCount: (group, count) => `${group} ${count}개`,
    next: "다음",
    onPath: "(위에 있음)",
    noComparison: "이 빌드에는 기준 비교가 없다",
  });
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  const where = (at) => (at ? `${at.path}:${at.line}` : "");
  const labelText = (labels) => (labels?.length ? ` [${labels.join(", ")}]` : "");
  const push = (map, key, value) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

  // ---------- index and closure ----------

  // Reaching a class reaches its constructor, as the check does: a function
  // node <file>#<Class>.constructor (or __init__) belongs to the class
  // <file>#<Class> (or the first <file>#<Class>~1 when the name repeats).
  function index(graph) {
    const nodes = new Map(),
      out = new Map(),
      into = new Map(),
      constructors = new Map(),
      ownerOf = new Map(),
      byType = new Map();
    for (const node of graph?.nodes || []) {
      nodes.set(node.id, node);
      push(byType, node.type, node);
    }
    for (const edge of graph?.edges || []) {
      push(out, edge.from, edge);
      push(into, edge.to, edge);
    }
    for (const node of nodes.values()) {
      if (node.type !== "코드" || node.kind !== "function") continue;
      const match = /^(.*#.+)\.(?:constructor|__init__)(?:~\d+)?$/.exec(node.id);
      if (!match) continue;
      const owner = [match[1], `${match[1]}~1`].map((id) => nodes.get(id)).find((item) => item?.type === "코드" && item.kind === "class");
      if (!owner) continue;
      push(constructors, owner.id, node.id);
      ownerOf.set(node.id, owner.id);
    }
    const typeOrder = new Map((graph?.nodeTypes || []).map((item, position) => [item.type, position]));
    return { graph, nodes, out, into, constructors, ownerOf, byType, typeOrder };
  }

  // Every node reached from starts over resolved call and callback edges (and
  // class → constructor): the closure the check uses for 어느 기능에서도 닿지
  // 않는 코드. Starts are included.
  function closure(ix, starts) {
    const visited = new Set(),
      stack = [...starts];
    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of ix.out.get(id) || []) if (CODE_EDGES.has(edge.type)) stack.push(edge.to);
      for (const target of ix.constructors.get(id) || []) stack.push(target);
    }
    return visited;
  }

  // Everything from which one of targets is reached in that closure.
  function reverseClosure(ix, targets) {
    const visited = new Set(),
      stack = [...targets];
    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of ix.into.get(id) || []) if (CODE_EDGES.has(edge.type)) stack.push(edge.from);
      const owner = ix.ownerOf.get(id);
      if (owner) stack.push(owner);
    }
    return visited;
  }

  const handlersOf = (ix, id) => [...new Set((ix.out.get(id) || []).filter((edge) => edge.type === "기능→코드").map((edge) => edge.to))];

  // The 기능 a node stands for when reach starts from it.
  function functionsBehind(ix, node) {
    if (node.type === "기능") return [node.id];
    const via = (id, type) => [...new Set((ix.out.get(id) || []).filter((edge) => edge.type === type).map((edge) => edge.to))];
    if (node.type === "화면요소") return via(node.id, "화면요소→기능");
    if (node.type === "유저 활동") return [...new Set(via(node.id, "유저 활동→화면요소").flatMap((element) => via(element, "화면요소→기능")))];
    if (node.type === "화면")
      return [...new Set([...via(node.id, "화면→기능"), ...via(node.id, "화면→화면요소").flatMap((element) => via(element, "화면요소→기능"))])];
    return [];
  }

  // ---------- context ----------

  function context({ graph, check = null, freshness = null, builtAt = null, baselineNow = null, changes = undefined }) {
    const ctx = { graph, check, freshness, builtAt, baselineNow, changes: changes === undefined ? check?.changes || null : changes, ix: index(graph) };
    ctx.confirmations = check?.confirmations || null;
    ctx.marks = changeMarks(ctx.changes);
    ctx.checkMarks = checkMarks(ctx.confirmations);
    ctx.unresolved = new Map();
    for (const item of check?.lists?.unresolvedHandlers || []) if (!ctx.unresolved.has(item.id)) ctx.unresolved.set(item.id, item.reason);
    return ctx;
  }

  function changeMarks(changes) {
    const marks = new Map();
    if (!changes || changes.status !== "compared") return marks;
    for (const group of changes.byType || []) {
      for (const id of group.changed || []) marks.set(id, "changed");
      for (const id of group.added || []) marks.set(id, "added");
    }
    for (const item of changes.reachChanged || []) if (!marks.has(item.id)) marks.set(item.id, "reach");
    return marks;
  }

  // A 기능 whose 뜻 line needs a look, by what the confirmation records say.
  function checkMarks(confirmations) {
    const marks = new Map();
    if (!confirmations || confirmations.status !== "compared") return marks;
    for (const key of ["changedSinceCheck", "textChanged", "otherReader", "neverChecked"])
      for (const item of confirmations[key] || []) if (item.kind === "meaning" && !marks.has(item.id)) marks.set(item.id, CHECK_WORDS[key]);
    return marks;
  }

  // ---------- one line per node ----------

  function basisMark(basis) {
    if (!basis || !basis.status || basis.status === "직접 씀") return "";
    if (basis.status === "승인") return " [승인]";
    const kind = `추정: ${basis.estimateKind || "어느 쪽 추정인지 적지 않음"}`;
    return basis.status === "승인 뒤 바뀜" ? ` [${kind}, 승인 뒤 바뀜]` : ` [${kind}]`;
  }

  function position(node) {
    if (node.type === "코드") {
      if (!node.lines) return node.file || "";
      return `${node.file}:${node.lines[0]}${node.lines[1] !== node.lines[0] ? `-${node.lines[1]}` : ""}`;
    }
    if (node.type === "기능")
      return node.positions?.length ? `${where(node.positions[0])}${node.positions.length > 1 ? ` 외 ${node.positions.length - 1}곳` : ""}` : "";
    return node.at ? where(node.at) : "";
  }

  const plainWords = (node) => node.oneLine || node.name || "";

  function nodeLine(ctx, id) {
    if (typeof id === "string" && id.startsWith("@")) return pseudoLine(ctx, id);
    const node = ctx.ix.nodes.get(id);
    if (!node) return `없는 ID ${id}`;
    const words = plainWords(node);
    let detail = "";
    if (node.type === "코드") detail = ` (${node.kind})`;
    else if (node.type === "기능") detail = ` (${node.kind}, ${node.handling})`;
    else if (node.type === "정책" && node.kind) detail = ` (${node.kind})`;
    const at = position(node);
    const mark = ctx.marks.get(id);
    const checkMark = ctx.checkMarks?.get(id);
    let line = `${node.type} ${id}${words ? ` — ${words}` : ""}${detail}${at ? ` ${at}` : ""}${basisMark(node.basis)}${mark ? ` {${CHANGE_WORDS[mark]}}` : ""}${checkMark ? ` {뜻: ${checkMark}}` : ""}`;
    if (node.type === "기능" && !handlersOf(ctx.ix, id).length && node.handling === "따라간다")
      line += ` — 처리 코드 없음: ${ctx.unresolved.get(id) || "처리 코드를 찾지 못함"}`;
    return line;
  }

  // ---------- starts (pseudo nodes) ----------

  const hasDocuments = (ctx) =>
    ["제품코어", "유저저니", "IA", "유저 활동", "화면", "화면요소", "정책"].some((type) => (ctx.ix.byType.get(type) || []).length);

  function functionKinds(ctx) {
    const kinds = new Map();
    for (const node of ctx.ix.byType.get("기능") || []) push(kinds, node.kind, node.id);
    return [...kinds.entries()].sort((a, b) => compare(a[0], b[0]));
  }

  function changedIds(ctx) {
    const list = [];
    for (const [id, mark] of ctx.marks) list.push({ id, mark });
    return list.sort((a, b) => compare(a.mark, b.mark) || compare(a.id, b.id));
  }

  const PSEUDO = Object.freeze({
    "@기능": "기능을 호출 방식별로",
    "@화면": "화면별로",
    "@유저 활동": "유저 활동",
    "@파일": "파일별로",
    "@바뀐 것": "기준 뒤 바뀐 것",
  });

  function pseudoChildren(ctx, id) {
    const sorted = (type) => (ctx.ix.byType.get(type) || []).map((node) => node.id).sort(compare);
    if (id === "@기능") return functionKinds(ctx).map(([kind]) => ({ group: "호출 방식", to: `@기능/${kind}` }));
    if (id.startsWith("@기능/")) {
      const kind = id.slice("@기능/".length);
      return (ctx.ix.byType.get("기능") || [])
        .filter((node) => node.kind === kind)
        .map((node) => node.id)
        .sort(compare)
        .map((to) => ({ group: "기능", to }));
    }
    if (id === "@화면") return sorted("화면").map((to) => ({ group: "화면", to }));
    if (id === "@유저 활동") return sorted("유저 활동").map((to) => ({ group: "유저 활동", to }));
    if (id === "@파일")
      return (ctx.ix.byType.get("코드") || [])
        .filter((node) => node.id === node.file)
        .map((node) => node.id)
        .sort(compare)
        .map((to) => ({ group: "파일", to }));
    if (id === "@바뀐 것") return changedIds(ctx).map((item) => ({ group: CHANGE_WORDS[item.mark], to: item.id }));
    return null;
  }

  function pseudoLine(ctx, id) {
    const children = pseudoChildren(ctx, id);
    if (!children) return `없는 ID ${id}`;
    if (id.startsWith("@기능/")) return `${id} — 기능 ${children.length}개`;
    return `${id} — ${PSEUDO[id]} ${children.length}개`;
  }

  // ---------- one step ----------

  // Children one step along (or against) the stored edges, one entry per
  // (edge type, other end), grouped by edge type in a stable order.
  function step(ctx, id, direction) {
    if (id.startsWith("@")) return pseudoChildren(ctx, id);
    if (!ctx.ix.nodes.has(id)) return null;
    const edges = (direction === "down" ? ctx.ix.out : ctx.ix.into).get(id) || [];
    const seen = new Map();
    for (const edge of edges) {
      const other = direction === "down" ? edge.to : edge.from;
      const key = `${edge.type}\0${other}`;
      if (seen.has(key)) seen.get(key).count += edge.count || 1;
      else seen.set(key, { group: edge.type, to: other, edge, count: edge.count || 1 });
    }
    const node = ctx.ix.nodes.get(id);
    const screenOf = (element) => (ctx.ix.into.get(element) || []).find((edge) => edge.type === "화면→화면요소")?.from || "";
    const list = [...seen.values()];
    // A 유저 활동's 화면요소 are grouped under their 화면.
    if (direction === "down" && node.type === "유저 활동")
      for (const item of list) if (item.group === "유저 활동→화면요소") item.screen = screenOf(item.to);
    return list.sort((a, b) => compare(a.group, b.group) || compare(a.screen || "", b.screen || "") || compare(a.to, b.to));
  }

  function childText(ctx, item) {
    let line = nodeLine(ctx, item.to);
    if (item.screen !== undefined) line += item.screen ? ` (화면 ${item.screen})` : " (화면 없음)";
    if (item.edge?.basis) line += ` ← ${where(item.edge.at)}${basisMark(item.edge.basis)}`;
    if (item.edge && CODE_EDGES.has(item.edge.type) && item.count > 1) line += ` ×${item.count}`;
    return line;
  }

  // ---------- questions ----------

  function freshnessLine(ctx) {
    const built = ctx.builtAt ? `빌드: ${ctx.builtAt} (graph.json 파일 시각)` : "빌드: 시각 모름";
    return `${built} — ${ctx.freshness?.text || "소스가 바뀌었는지 알 수 없음"}`;
  }

  function limitsLine(ctx) {
    const calls = ctx.graph?.limits?.calls || ctx.check?.limits?.calls;
    if (calls?.canBeProduct !== undefined)
      return `읽은 범위: 제품 코드일 수 있는 호출 ${calls.canBeProduct}개 중 ${calls.resolved}개를 풀었다. 풀린 call·callback만 따라간다. 타입 없는 글자 스캔이다.`;
    const all = calls?.all ?? ctx.graph?.referenceSummary?.allCalls;
    const resolved = calls?.resolved ?? ctx.graph?.referenceSummary?.resolvedCalls;
    if (all === undefined || resolved === undefined) return "읽은 범위: 이 빌드에는 호출 수가 없다(이전 버전의 빌드). 풀린 call·callback만 따라간다. 타입 없는 글자 스캔이다.";
    return `읽은 범위: 호출 ${all}개 중 ${resolved}개를 풀었다(${OLDER_CALLS}). 풀린 call·callback만 따라간다. 타입 없는 글자 스캔이다.`;
  }

  function changesLine(ctx) {
    const changes = ctx.changes;
    if (!changes) return "기준 없음 — 이 빌드에는 기준 비교가 없다";
    if (changes.status !== "compared") return `기준 없음 — ${changes.reason}`;
    const c = changes.counts;
    const moved = ctx.baselineNow && ctx.baselineNow.setAt !== changes.baseline.setAt ? ` (기준이 그 뒤 ${ctx.baselineNow.setAt}로 옮겨졌다. 다시 빌드하면 새 기준과 비교한다)` : "";
    return `기준 뒤 바뀐 것 (기준 ${changes.baseline.setAt}): 변경 ${c.changed} · 신규 ${c.added} · 사라짐 ${c.removed} · 닿는 코드가 바뀜 ${c.reachChanged} · 다시 볼 것 ${c.reviewAgain}${moved}`;
  }

  const headerLines = (ctx) => [freshnessLine(ctx), limitsLine(ctx), changesLine(ctx)];

  function page(items, { limit = LIMIT, cursor = 0 } = {}) {
    const start = Math.max(0, Number(cursor) || 0),
      size = Math.max(1, Number(limit) || LIMIT);
    const slice = items.slice(start, start + size);
    const remaining = Math.max(0, items.length - start - slice.length);
    return { slice, total: items.length, cursor: start, limit: size, remaining, nextCursor: remaining ? start + slice.length : null };
  }

  function moreRow(level, paged, hint) {
    return { depth: level, kind: "more", hint, text: `외 ${paged.remaining}개 — 다음: ${hint}` };
  }

  function nearest(ctx, id) {
    return find(ctx, String(id).replace(/^@/, ""))
      .slice(0, 5)
      .map((node) => node.id);
  }

  // Typed input: compared in NFC, and a path typed with backslashes matches
  // the stored forward slashes.
  const fold = (value) => String(value).normalize("NFC").toLocaleLowerCase();
  const needles = (text) => {
    const value = fold(text || "");
    return value ? [...new Set([value, value.replaceAll("\\", "/")])] : [];
  };
  function resolveId(ctx, id) {
    if (typeof id !== "string" || !id || ctx.ix.nodes.has(id) || pseudoChildren(ctx, id)) return id;
    for (const candidate of [id.normalize("NFC"), id.replaceAll("\\", "/"), id.normalize("NFC").replaceAll("\\", "/")]) if (ctx.ix.nodes.has(candidate) || pseudoChildren(ctx, candidate)) return candidate;
    return id;
  }

  // Request-local full-text index. This ranks words, never product meaning,
  // approval, currentness or causality. No edges are inferred from a match.
  function searchTokens(value) {
    const parts = String(value).replace(/([a-z\d])([A-Z])/g, "$1 $2").normalize("NFC").toLowerCase().match(/[\p{L}\p{N}_$]+/gu) || [];
    const tokens = [];
    for (const word of parts) {
      tokens.push(word);
      // Character bigrams let inflected Korean questions find the written
      // words without a product-specific vocabulary or stemmer.
      if (/^[가-힣]{3,}$/.test(word)) for (let i = 0; i < word.length - 1; i += 1) tokens.push(word.slice(i, i + 2));
      if (word.includes("_")) tokens.push(...word.split("_").filter(Boolean));
    }
    return tokens;
  }

  // Built once per context (one graph) and kept on it; nothing is kept between
  // contexts, so an answer never depends on what was asked before.
  function searchIndex(ctx) {
    if (ctx.searchIndex) return ctx.searchIndex;
    const documents = [], postings = new Map();
    const stats = { tokenizedNodes: 0 };
    for (const node of ctx.ix.nodes.values()) {
      const fields = Object.fromEntries(Object.entries(node).filter(([key, value]) => typeof value === "string" && !/sha256|^type$|^kind$/i.test(key)));
      fields.path = [node.file, node.at?.path, ...(node.positions || []).map((p) => p.path)].filter(Boolean).join(" ");
      const terms = new Map(), tokens = Object.values(fields).flatMap(searchTokens);
      for (const token of tokens) terms.set(token, (terms.get(token) || 0) + 1);
      stats.tokenizedNodes += 1;
      const doc = { node, fields, terms, length: tokens.length };
      documents.push(doc);
      for (const token of terms.keys()) push(postings, token, doc);
    }
    const average = documents.reduce((n, doc) => n + doc.length, 0) / Math.max(1, documents.length);
    return (ctx.searchIndex = { documents, postings, average: average || 1, stats });
  }

  function connections(ctx, id, limit = 6) {
    return [...(ctx.ix.into.get(id) || []), ...(ctx.ix.out.get(id) || [])]
      .filter((edge) => ctx.ix.nodes.has(edge.from) && ctx.ix.nodes.has(edge.to))
      .sort((a, b) => compare(a.type, b.type) || compare(a.from, b.from) || compare(a.to, b.to))
      .slice(0, limit)
      .map((edge) => ({ type: edge.type, from: edge.from, to: edge.to, ...(edge.at ? { at: edge.at } : {}), ...(edge.basis ? { basis: edge.basis } : {}) }));
  }

  function search(ctx, text, { nodeTypes = [], relatedTo = null, edgeTypes = [], basisStates = [], depth = 1 } = {}) {
    const wanted = needles(text);
    if (!wanted.length) return [];
    const ix = searchIndex(ctx), tokens = [...new Set(searchTokens(text))], scores = new Map();
    let nearby = null;
    if (relatedTo) {
      nearby = new Set(ctx.ix.nodes.has(resolveId(ctx, relatedTo)) ? [resolveId(ctx, relatedTo)] : []);
      let frontier = [...nearby];
      for (let level = 0; level < depth; level += 1) {
        const next = [];
        for (const id of frontier) for (const edge of [...(ctx.ix.out.get(id) || []), ...(ctx.ix.into.get(id) || [])]) {
          if (edgeTypes.length && !edgeTypes.includes(edge.type)) continue;
          const target = edge.from === id ? edge.to : edge.from;
          if (ctx.ix.nodes.has(target) && !nearby.has(target)) { nearby.add(target); next.push(target); }
        }
        frontier = next;
      }
    }
    const candidates = ix.documents.filter(({ node }) => (!nodeTypes.length || nodeTypes.includes(node.type)) && (!nearby || nearby.has(node.id)) && (!basisStates.length || basisStates.includes(node.basis?.status)));
    const allowed = new Set(candidates), average = candidates.reduce((n, doc) => n + doc.length, 0) / Math.max(1, candidates.length) || 1;
    for (const token of tokens) {
      const docs = (ix.postings.get(token) || []).filter((doc) => allowed.has(doc));
      const idf = Math.log(1 + (candidates.length - docs.length + 0.5) / (docs.length + 0.5));
      for (const doc of docs) {
        const tf = doc.terms.get(token);
        scores.set(doc, (scores.get(doc) || 0) + idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.length / average)));
      }
    }
    // Preserve ID/path and literal-substring discovery even when tokenisation
    // cannot represent the input (punctuation, a partial code identifier).
    for (const doc of candidates) {
      const hit = (value) => wanted.some((word) => fold(value || "").replaceAll("\\", "/").includes(word));
      if (!scores.has(doc) && Object.values(doc.fields).some(hit)) scores.set(doc, 0);
    }
    return [...scores].map(([doc, score]) => {
      const exact = wanted.some((word) => [doc.node.id, doc.node.file, doc.node.at?.path, ...(doc.node.positions || []).map((p) => p.path)]
        .some((value) => typeof value === "string" && fold(value).replaceAll("\\", "/") === word));
      const matchedTerms = tokens.filter((term) => doc.terms.has(term));
      return { node: doc.node, score, exact, matchedTerms, basis: doc.node.basis || null };
    }).sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || compare(a.node.id, b.node.id));
  }

  function find(ctx, text) {
    return search(ctx, text).map((item) => item.node);
  }

  const stable = (value) => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b))) : item);
  const edgeIdentity = (edge, detailed = true) => stable([edge.type, edge.from, edge.to, ...(detailed ? [edge.at || null, edge.count || 1, edge.basis || null] : [])]);

  // Three-way structural preview only. The proposal's declared starting point
  // is not guessed from a timestamp, a title or a convenient current file.
  function impact(ctx, { proposalBase = null, candidate = null, compatibility = null } = {}) {
    if (!candidate?.nodes || !candidate?.edges) return { status: "unavailable", reason: "제안 빌드를 받지 않았다", conflicts: [], remainingReferences: [] };
    if (!proposalBase?.nodes || !proposalBase?.edges) return { status: "unavailable", reason: "제안 출발 기준이 없다", conflicts: [], remainingReferences: [] };
    const minimal = proposalBase.kind === "LodeProductGraphBaseline";
    const base = minimal ? {
      nodes: proposalBase.nodes.map(([id, type, kind, file, lines, contentSha256, reachSha256]) => ({ id, type, kind, file, lines, contentSha256, reachSha256 })),
      edges: proposalBase.edges.map(([type, from, to]) => ({ type, from: typeof from === "number" ? proposalBase.nodes[from]?.[0] : from, to: typeof to === "number" ? proposalBase.nodes[to]?.[0] : to })),
    } : proposalBase;
    const shaped = (graph) => Array.isArray(graph.nodes) && Array.isArray(graph.edges) && graph.nodes.every((n) => n && typeof n.id === "string" && typeof n.type === "string") && new Set(graph.nodes.map((n) => n.id)).size === graph.nodes.length && graph.edges.every((e) => e && [e.type, e.from, e.to].every((v) => typeof v === "string") && (e.count === undefined || Number.isSafeInteger(e.count) && e.count > 0) && (e.at == null || typeof e.at.path === "string" && Number.isSafeInteger(e.at.line) && e.at.line > 0));
    if (![base, ctx.graph, candidate].every(shaped)) return { status: "unavailable", reason: "중복 ID 또는 잘못된 노드/edge 모양", conflicts: [], remainingReferences: [] };
    const maps = [base, ctx.graph, candidate].map((graph) => new Map(graph.nodes.map((node) => [node.id, node])));
    const state = (node) => {
      if (!node) return null;
      if (minimal) return stable([node.type, node.contentSha256 ?? null, node.reachSha256 ?? null]);
      const { at, positions, lines, ...rest } = node;
      return stable(rest);
    };
    const conflicts = [], currentChanges = [], proposedChanges = [], affected = new Set();
    for (const id of [...new Set(maps.flatMap((map) => [...map.keys()]))].sort(compare)) {
      const [old, current, proposed] = maps.map((map) => map.get(id)), [b, c, p] = [old, current, proposed].map(state);
      if (b !== c) currentChanges.push(id);
      if (b !== p) { proposedChanges.push(id); affected.add(id); }
      if (b !== c && b !== p && c !== p) conflicts.push({ kind: old?.type === "정책" || current?.type === "정책" || proposed?.type === "정책" ? "concurrent-policy-change" : "divergent-node-change", id, before: old || null, current: current || null, proposed: proposed || null });
    }
    // A counted call is one logical typed relation; count/basis are state,
    // never a different identity. Multiple citations of the same endpoints
    // remain occurrences distinguished by their original source position.
    const grouped = [base, ctx.graph, candidate].map((graph) => {
      const groups = new Map();
      for (const edge of graph.edges) push(groups, edgeIdentity(edge, false), edge);
      return groups;
    });
    const parallelGroups = new Set([...new Set(grouped.flatMap((groups) => [...groups.keys()]))].filter((key) => grouped.some((groups) => (groups.get(key)?.length || 0) > 1)));
    const ambiguousRelations = [];
    const edgeMaps = grouped.map((groups, side) => {
      const out = new Map();
      for (const [logical, edges] of groups) for (const [ordinal, edge] of edges.entries()) {
        let key = logical;
        if (parallelGroups.has(logical)) {
          if (!edge.at?.path || !Number.isInteger(edge.at?.line)) {
            ambiguousRelations.push({ side, edge, reason: "병렬 관계의 출처 위치를 확인할 수 없다" });
            key += `\0unmatched:${ordinal}`;
          } else key += `\0${stable(edge.at)}`;
        }
        if (out.has(key)) {
          ambiguousRelations.push({ side, edge, reason: "같은 출처의 병렬 관계를 하나로 식별할 수 없다" });
          key += `\0duplicate:${ordinal}`;
        }
        out.set(key, edge);
      }
      return out;
    });
    const edgeState = (edge) => {
      if (!edge) return null;
      if (minimal) return edgeIdentity(edge, false); // the old tuples do not record count/basis
      const { at, ...fields } = edge;
      return stable({ ...fields, count: edge.count ?? 1, basis: edge.basis ?? null });
    };
    const edgeChanges = [];
    const effectiveEdges = new Map();
    for (const key of [...new Set(edgeMaps.flatMap((map) => [...map.keys()]))].sort(compare)) {
      const [old, current, proposed] = edgeMaps.map((map) => map.get(key));
      const [b, c, p] = [old, current, proposed].map(edgeState);
      if (b !== c && b !== p && c !== p) conflicts.push({ kind: !current || !proposed ? "edge-delete-versus-update" : "divergent-edge-change", edge: proposed || current || old, before: old || null, current: current || null, proposed: proposed || null });
      if (b !== p) {
        const edge = proposed || old;
        edgeChanges.push({ ...edge, change: !old ? "added" : !proposed ? "removed" : "changed", before: old || null, after: proposed || null });
        affected.add(edge.from); affected.add(edge.to);
      }
      const effective = b !== p ? proposed : current;
      if (effective) effectiveEdges.set(key, effective);
    }
    const removed = new Set(proposedChanges.filter((id) => maps[0].has(id) && !maps[2].has(id)));
    const currentOnly = currentChanges.filter((id) => !proposedChanges.includes(id));
    const effectiveNodes = new Set([...maps[2].keys(), ...currentOnly.filter((id) => maps[1].has(id) && !removed.has(id))]);
    for (const id of currentOnly) if (!maps[1].has(id)) effectiveNodes.delete(id);
    const remainingReferences = [...effectiveEdges.values()].filter((edge) => !effectiveNodes.has(edge.from) || !effectiveNodes.has(edge.to)).map((edge) => ({ ...edge, missing: [edge.from, edge.to].filter((id) => !effectiveNodes.has(id)) }));
    for (const edge of remainingReferences) conflicts.push({ kind: "remaining-reference", edge });
    // Bounded reverse impact over actual relations; no semantic edges added.
    const queue = [...affected], visited = new Set(queue);
    const impactIndexes = [ctx.ix, index(candidate)];
    for (let i = 0; i < queue.length; i += 1) for (const ix of impactIndexes) {
      for (const edge of ix.into.get(queue[i]) || []) if (!visited.has(edge.from) && ix.nodes.has(edge.from)) { visited.add(edge.from); queue.push(edge.from); }
    }
    const complete = !minimal && compatibility?.status === "verified" && !ambiguousRelations.length;
    return { status: complete ? "compared" : "partial", compatibility: compatibility || { status: "unknown", reasons: ["빌드/Project/소스 루트/reader 근거 미확인"] }, basis: minimal ? "baseline hashes; historical display may be unavailable" : "explicit proposal starting build", conflicts, ambiguousRelations, remainingReferences, currentChanges, proposedChanges, edgeChanges, affected: [...visited].sort(compare), structuralConflictFree: complete ? conflicts.length === 0 : null, productApproved: false, causeInferred: false };
  }

  function impactAnswer(result, { answer, limit, cursor }) {
    const items = [
      ...(result.conflicts || []).map((item) => ({ text: `${item.kind}: ${item.id || `${item.edge.from} → ${item.edge.to}`}`, detail: item })),
      ...(result.ambiguousRelations || []).map((item) => ({ text: `${item.reason}: ${item.edge.from} → ${item.edge.to}`, detail: item })),
      ...(result.affected || []).map((id) => ({ id, text: `확인할 실제 연결: ${id}` })),
    ];
    const paged = page(items, { limit, cursor });
    const rows = [{ depth: 0, kind: "text", text: `구조적 미리보기 (${result.status}). 충돌 없음은 제품 승인이 아니다. ${result.reason || result.basis || ""}${result.compatibility?.reasons?.length ? ` — ${result.compatibility.reasons.join(" / ")}` : ""}` },
      ...paged.slice.map((item) => ({ depth: 1, kind: item.id ? "node" : "text", ...item }))];
    if (paged.remaining) rows.push(moreRow(1, paged, `impact --cursor ${paged.nextCursor}`));
    const { conflicts, ambiguousRelations, affected, edgeChanges, currentChanges, proposedChanges, remainingReferences, ...summary } = result;
    return answer("반영 전 영향 미리보기", rows, { impact: { ...summary, counts: { conflicts: conflicts?.length || 0, ambiguousRelations: ambiguousRelations?.length || 0, affected: affected?.length || 0, edgeChanges: edgeChanges?.length || 0, currentChanges: currentChanges?.length || 0, proposedChanges: proposedChanges?.length || 0, remainingReferences: remainingReferences?.length || 0 }, conflicts: paged.slice.filter((item) => item.detail?.kind).map((item) => item.detail), ambiguousRelations: paged.slice.filter((item) => item.detail?.reason).map((item) => item.detail), affected: paged.slice.filter((item) => item.id).map((item) => item.id), coverage: paged.remaining ? "partial-page" : "complete-page" }, page: { total: paged.total, cursor: paged.cursor, limit: paged.limit, remaining: paged.remaining, nextCursor: paged.nextCursor } });
  }

  // Reach: from a 기능 (or what stands for 기능) the code reached; from a 코드
  // node or a file the 기능 that reach it.
  function reach(ctx, id) {
    const node = ctx.ix.nodes.get(id);
    if (!node) return null;
    if (node.type === "코드") {
      const targets = node.id === node.file ? [node.id, ...(ctx.ix.byType.get("코드") || []).filter((item) => item.file === node.id).map((item) => item.id)] : [node.id];
      const reachers = reverseClosure(ctx.ix, targets);
      const functions = (ctx.ix.byType.get("기능") || []).filter((item) => handlersOf(ctx.ix, item.id).some((handler) => reachers.has(handler)));
      return { direction: "up", ids: functions.map((item) => item.id).sort(compare) };
    }
    const functions = functionsBehind(ctx.ix, node);
    if (!functions.length && node.type !== "기능") return { direction: "down", ids: [], functions };
    const reached = closure(
      ctx.ix,
      functions.flatMap((item) => handlersOf(ctx.ix, item)),
    );
    const ids = [...reached].filter((item) => ctx.ix.nodes.get(item)?.type === "코드").sort(compare);
    return { direction: "down", ids, functions };
  }

  // What reach answers for a node: the code it reaches, or the 기능 that
  // reach it. Null when reach does not apply.
  function reachDirection(ctx, id) {
    const node = ctx.ix.nodes.get(id);
    if (!node) return null;
    if (node.type === "코드") return "functions";
    return ["기능", "화면요소", "유저 활동", "화면"].includes(node.type) ? "code" : null;
  }
  // The starts the page's question entrances open.
  const QUESTION_STARTS = Object.freeze({ element: "@화면", function: "@기능", file: "@파일" });

  // A down with --depth stops adding rows at this many and says so.
  const MAX_ROWS = 2000;
  function stepRows(ctx, id, direction, { depth, limit, cursor, path, level, hint, budget = { left: MAX_ROWS, cut: 0 } }) {
    const items = step(ctx, id, direction);
    const paged = page(items, { limit, cursor });
    const rows = [];
    const counts = new Map();
    for (const item of items) counts.set(item.group, (counts.get(item.group) || 0) + 1);
    let lastGroup = null;
    for (const item of paged.slice) {
      // Past the bound, a deeper level's rows are counted, not shown. The
      // first level is paged by --limit and always shown.
      if (level > 1 && budget.left <= 0) {
        budget.cut += 1;
        continue;
      }
      if (item.group !== lastGroup) {
        rows.push({ depth: level, kind: "group", text: WORDS.groupCount(item.group, counts.get(item.group)) });
        lastGroup = item.group;
      }
      const onPath = path.includes(item.to);
      rows.push({ depth: level + 1, kind: "node", id: item.to, text: childText(ctx, item) + (onPath ? ` ${WORDS.onPath}` : ""), onPath, group: item.group });
      budget.left -= 1;
      if (!onPath && depth > 1 && budget.left > 0 && (item.to.startsWith("@") || ctx.ix.nodes.has(item.to)))
        rows.push(
          ...stepRows(ctx, item.to, direction, { depth: depth - 1, limit, cursor: 0, path: [...path, item.to], level: level + 2, hint: `${direction} ${item.to}`, budget }),
        );
    }
    if (paged.remaining && (level === 1 || budget.left > 0)) rows.push(moreRow(level, paged, level === 1 ? `${hint} --cursor ${paged.nextCursor}` : hint));
    if (level === 1 && budget.cut)
      rows.push({ depth: level, kind: "more", text: `외 ${budget.cut}개 줄은 보이지 않았다 — 한 답의 줄 수 한도(${MAX_ROWS})에 닿았다. 다음: 그 줄에서 down <ID>` });
    return rows;
  }

  // The first block (facts) and the starts of overview, apart, so the page
  // can lay them out; ask("overview") prints both.
  function overviewParts(ctx) {
    const rows = overviewRows(ctx);
    const cut = rows.findIndex((row) => row.marker === "starts");
    return { facts: rows.slice(0, cut), starts: rows.slice(cut).filter((row) => row.id), guide: hasDocuments(ctx) ? [] : ctx.check?.guide || [] };
  }

  function overviewRows(ctx) {
    const rows = [];
    const add = (depth, text, extra = {}) => rows.push({ depth, kind: "text", text, ...extra });
    const notExtracted = new Set(ctx.graph?.limits?.notExtracted?.nodeTypes || []);
    add(0, "노드 수:");
    for (const item of ctx.graph?.nodeTypes || []) add(1, `${item.type} ${notExtracted.has(item.type) ? "뽑지 않음" : item.count}`);
    const documents = ctx.graph?.limits?.documents;
    if (documents) add(0, `문서: 승인 ${documents.approved} · 승인 뒤 바뀜 ${documents.changedAfterApproval} · 추정 ${documents.estimated}`);
    const calls = ctx.graph?.limits?.calls;
    if (calls?.notProduct)
      add(
        0,
        `호출: 전체 ${calls.all}개 — 제품 코드일 수 없는 것 ${calls.notProduct.builtIn + calls.notProduct.keyword}개, 제품 밖 모듈로 가는 것 ${calls.notProduct.external}개, 제품 코드일 수 있는 것 ${calls.canBeProduct}개 중 풀린 것 ${calls.resolved}개`,
      );
    if (ctx.graph?.limits?.notExtracted)
      add(0, `뽑지 않은 것: ${ctx.graph.limits.notExtracted.nodeTypes.join(", ")} 노드, ${ctx.graph.limits.notExtracted.edges.join(", ")} 연결`);
    if (ctx.graph?.limits?.execution) add(0, ctx.graph.limits.execution);
    add(0, "시작:", { marker: "starts" });
    if (hasDocuments(ctx)) {
      for (const id of ["제품코어", "유저저니"]) if (ctx.ix.nodes.has(id)) add(1, nodeLine(ctx, id), { kind: "node", id });
      add(1, pseudoLine(ctx, "@유저 활동"), { kind: "node", id: "@유저 활동" });
    } else {
      if (ctx.check?.guide?.length) {
        add(1, WORDS.guide);
        for (const item of ctx.check.guide) add(2, `${item.input} (${item.state}). 쓰는 곳: ${item.unlocks.join(", ")}. 다음: ${item.next}`);
      }
      for (const [kind] of functionKinds(ctx)) add(1, pseudoLine(ctx, `@기능/${kind}`), { kind: "node", id: `@기능/${kind}` });
    }
    add(0, "다른 시작:");
    for (const id of ["@화면", "@기능", "@파일", "@바뀐 것"]) add(1, pseudoLine(ctx, id), { kind: "node", id });
    add(0, "물어볼 것:");
    add(1, "이 화면요소를 쓰면 어떤 코드가 도나? — reach <화면요소 ID>");
    add(1, "이 기능은 어디서 쓰이나? — up <기능 ID>");
    add(1, "이 파일은 어떤 기능에서 닿나? — reach <파일 경로>");
    add(1, "빈 곳은? — gaps");
    return rows;
  }

  function nodeRows(ctx, id) {
    const node = ctx.ix.nodes.get(id);
    const rows = [];
    const add = (depth, text) => rows.push({ depth, kind: "text", text });
    if (node.basis) add(1, `근거: ${node.basis.path} (${node.basis.status}${node.basis.estimateKind ? `, ${node.basis.estimateKind}` : ""})`);
    if (node.type === "기능") {
      add(1, `처리: ${node.handling}`);
      for (const item of node.positions || []) add(1, `위치: ${where(item)}`);
    } else if (node.at) add(1, `위치: ${where(node.at)}`);
    else if (node.type === "코드") add(1, `위치: ${position(node)}`);
    const counts = (map) => {
      const byType = new Map();
      for (const edge of map.get(id) || []) byType.set(edge.type, (byType.get(edge.type) || 0) + 1);
      return [...byType.entries()].sort((a, b) => compare(a[0], b[0])).map(([type, count]) => `${type} ${count}`);
    };
    const down = counts(ctx.ix.out),
      up = counts(ctx.ix.into);
    add(1, `나가는 연결: ${down.length ? down.join(", ") : "없음"}`);
    add(1, `들어오는 연결: ${up.length ? up.join(", ") : "없음"}`);
    const mark = ctx.marks.get(id);
    if (ctx.changes?.status === "compared") add(1, `기준 뒤: ${mark ? CHANGE_WORDS[mark] : "변화 없음"}`);
    return rows;
  }

  function pathLine(ctx, path) {
    return `경로: ${path.map((id) => (id.startsWith("@") ? id : `${ctx.ix.nodes.get(id)?.type || "없는 ID"} ${id}`)).join(" › ")}`;
  }

  // One answer. question: overview | node | down | up | reach | find | gaps | changes.
  function ask(ctx, request = {}) {
    const { question = "overview", text = "", list = null, limit = LIMIT, cursor = 0, depth = 1 } = request;
    const id = resolveId(ctx, request.id ?? "");
    const header = headerLines(ctx);
    const answer = (title, rows, extra = {}) => {
      const lines = [...header, title, ...rows.map((row) => `${"  ".repeat(row.depth)}${row.text}`)];
      return { ok: true, question, header, title, rows, text: lines.join("\n") + "\n", ...extra };
    };
    const notFound = () => {
      const near = nearest(ctx, id);
      const result = fail("PRODUCT_GRAPH_NODE_NOT_FOUND", `${id}라는 노드가 이 그래프에 없다.${near.length ? ` 가까운 것: ${near.join(", ")}` : ""}`, { nearest: near });
      return { ...result, header, text: [...header, result.message].join("\n") + "\n" };
    };
    if (question === "overview") return answer("개요", overviewRows(ctx));
    if (question === "find") {
      const matches = search(ctx, text, request);
      const paged = page(matches, { limit, cursor });
      for (const item of paged.slice) item.connections = connections(ctx, item.node.id);
      const rows = paged.slice.flatMap((item) => [
        { depth: 1, kind: "node", id: item.node.id, text: nodeLine(ctx, item.node.id), score: item.score, exact: item.exact, matchedTerms: item.matchedTerms },
        ...item.connections.map((edge) => ({ depth: 2, kind: "text", text: `${edge.from} —${edge.type}→ ${edge.to}${edge.at ? ` (${where(edge.at)})` : ""}`, edge })),
      ]);
      rows.unshift({ depth: 0, kind: "text", text: "관련 단어순(BM25); 검색 점수는 승인·현재성·인과가 아니다. 아래 연결은 기록된 edge만이다." });
      if (paged.remaining) rows.push(moreRow(1, paged, `find ${JSON.stringify(String(text))} --cursor ${paged.nextCursor}`));
      return answer(`찾기: ${text} — ${matches.length}개`, rows, { search: { algorithm: "BM25", semanticJudgment: false, indexing: ctx.searchIndex?.stats, results: paged.slice.map(({ node, ...item }) => ({ id: node.id, ...item })) }, page: { total: paged.total, cursor: paged.cursor, limit: paged.limit, remaining: paged.remaining, nextCursor: paged.nextCursor } });
    }
    if (question === "gaps") return gapsAnswer(ctx, { list, limit, cursor, answer });
    if (question === "changes") return changesAnswer(ctx, { list, limit, cursor, answer });
    if (question === "impact") return impactAnswer(impact(ctx, request), { answer, limit, cursor });
    if (!["node", "down", "up", "reach"].includes(question)) return fail("PRODUCT_GRAPH_QUERY_INVALID", `모르는 질문: ${question}`);
    const pseudo = id.startsWith("@");
    if (pseudo ? !pseudoChildren(ctx, id) || question !== "down" : !ctx.ix.nodes.has(id)) return notFound();
    const root = { depth: 0, kind: "node", id, text: nodeLine(ctx, id) };
    if (question === "node") return answer(pathLine(ctx, [id]), [root, ...nodeRows(ctx, id)]);
    if (question === "down" || question === "up") {
      const items = step(ctx, id, question);
      const rows = [root, ...stepRows(ctx, id, question, { depth: Math.max(1, Number(depth) || 1), limit, cursor, path: [id], level: 1, hint: `${question} ${id}` })];
      if (!items.length) rows.push({ depth: 1, kind: "text", text: question === "down" ? "아래로 이어지는 연결 없음" : "이것을 가리키는 것 없음" });
      const paged = page(items, { limit, cursor });
      return answer(pathLine(ctx, [id]), rows, { page: { total: paged.total, cursor: paged.cursor, limit: paged.limit, remaining: paged.remaining, nextCursor: paged.nextCursor } });
    }
    if (!reachDirection(ctx, id))
      return answer(pathLine(ctx, [id]), [
        root,
        { depth: 1, kind: "text", text: `닿음은 ${ctx.ix.nodes.get(id).type}에 쓰지 않는다. 기능·화면요소·유저 활동·화면에서는 닿는 코드를, 코드 노드나 파일에서는 닿는 기능을 묻는다.` },
      ]);
    const reached = reach(ctx, id);
    const paged = page(reached.ids, { limit, cursor });
    const rows = [root];
    const note = "풀린 call·callback 참조만 따라간다. 어느 기능에서도 닿지 않는 코드 검사와 같은 닫힘이다";
    if (reached.direction === "up") rows.push({ depth: 1, kind: "group", text: `이 코드에 닿는 기능 ${reached.ids.length}개 (${note})` });
    else {
      if (ctx.ix.nodes.get(id).type !== "기능") rows.push({ depth: 1, kind: "text", text: `거치는 기능 ${reached.functions.length}개: ${reached.functions.join(", ") || "없음"}` });
      rows.push({ depth: 1, kind: "group", text: `닿는 코드 ${reached.ids.length}개 (${note})` });
    }
    for (const target of paged.slice) rows.push({ depth: 2, kind: "node", id: target, text: nodeLine(ctx, target) });
    if (paged.remaining) rows.push(moreRow(1, paged, `reach ${id} --cursor ${paged.nextCursor}`));
    return answer(pathLine(ctx, [id]), rows, {
      reach: reached,
      page: { total: paged.total, cursor: paged.cursor, limit: paged.limit, remaining: paged.remaining, nextCursor: paged.nextCursor },
    });
  }

  // ---------- check.txt parts ----------

  const listLines = (items) => {
    const lines = items.slice(0, LIST_LIMIT).map((item) => `  - ${item.text}`);
    if (items.length > LIST_LIMIT) lines.push(`  - 외 ${items.length - LIST_LIMIT}개 (구조화된 결과에 모두 있다)`);
    return lines;
  };

  const LIMITS_TITLE = "이 그래프가 답하지 못하는 것";

  // A build made by an older version (0.3.0-beta.124/125) has no split of the
  // calls and no call-reading lines: what it carries is shown, and what it does
  // not carry is said, never filled in.
  const OLDER_CALLS = "이 빌드는 제품 코드일 수 없는 호출과 제품 밖 모듈로 가는 호출을 따로 세지 않았다(이전 버전의 빌드)";
  function callsLine(calls) {
    if (!calls) return "- 이 빌드에는 호출 수가 없다(이전 버전의 빌드).";
    if (!calls.notProduct) return `- 호출 ${calls.all}개 중 ${calls.resolved}개를 하나의 선언으로 풀었다. 풀린 것만 코드→코드 연결이 된다. ${OLDER_CALLS}.`;
    return `- 호출 ${calls.all}개. 제품 코드일 수 없는 호출 ${calls.notProduct.builtIn + calls.notProduct.keyword}개(언어·런타임 내장 ${calls.notProduct.builtIn}, 호출처럼 보인 언어 키워드 ${calls.notProduct.keyword})와 제품 밖 모듈로 가는 호출 ${calls.notProduct.external}개를 빼면, 제품 코드일 수 있는 호출 ${calls.canBeProduct}개 중 ${calls.resolved}개를 하나의 선언으로 풀었다. 풀린 것만 코드→코드 연결이 된다.`;
  }

  function renderLimits(limits) {
    const documents = limits.documents;
    const usage = !documents.approvalsRead
      ? `독립 실행이라 승인 기록을 읽지 않았다(모든 문서가 추정). 이번 실행은 ${documents.includeEstimates ? `추정 문서 ${documents.used.length}개를 썼고, 그것에 기댄 결과에는 [추정: …]을 붙였다` : "추정 문서를 쓰지 않았다"}.`
      : documents.includeEstimates
        ? `이번 실행은 승인과 추정 문서 ${documents.used.length}개를 모두 썼고, 추정에 기댄 결과에는 [추정: …]을 붙였다.`
        : `이번 실행은 승인된 문서 ${documents.used.length}개만 썼다.`;
    return [
      limits.title,
      `- ${limits.codeReading}`,
      callsLine(limits.calls),
      ...(limits.callReading || []).map((line) => `- ${line}`),
      `- reference 종류는 ${limits.referenceKinds.emitted.join(", ")}만 적는다. ${limits.referenceKinds.notToldApart.join(", ")}는 구별하지 못해 적지 않는다.`,
      `- 뽑지 않은 것: ${limits.notExtracted.nodeTypes.join(", ")} 노드, ${limits.notExtracted.edges.join(", ")} 연결, ${limits.notExtracted.grouping}.`,
      ...limits.uiBindingScan.map((line) => `- ${line}`),
      ...(limits.tableRows ? [`- ${limits.tableRows}`] : []),
      ...(limits.lineLocalFallback.count
        ? [
            `- lexer가 파일 끝에서 문자열·템플릿·주석 안에 있어 코드만 판정을 줄 단위로 되돌린 파일 ${limits.lineLocalFallback.count}개: ${limits.lineLocalFallback.files.slice(0, 10).join(", ")}${limits.lineLocalFallback.count > 10 ? ` 외 ${limits.lineLocalFallback.count - 10}개` : ""}.`,
          ]
        : []),
      `- ${limits.execution}`,
      `- 문서: 승인 ${documents.approved}, 승인 뒤 바뀜 ${documents.changedAfterApproval}, 추정 ${documents.estimated}. 승인 뒤 바뀜은 승인 기록의 본문과 지금 본문이 달라 추정으로 쓴다. ${usage}`,
    ];
  }

  function renderGuide(guide) {
    if (!guide?.length) return [];
    return [
      WORDS.guide,
      ...guide.map((item) => `- ${item.input} (${item.state}). 쓰는 곳: ${item.unlocks.join(", ")}. 다음: ${item.next}`),
      "",
    ];
  }

  // The finding lines of one check, each with the node it names.
  function findingItems(check) {
    const items = [];
    for (const finding of check.findings || []) {
      if (check.key === "element-function-without-activity")
        items.push({ text: `${finding.id} → 기능 ${finding.functions.join(", ")} (${where(finding.at)})${labelText(finding.labels)}`, nodeId: finding.id });
      else if (check.key === "screen-without-activity")
        items.push({ text: `${finding.id}${finding.name ? ` ${finding.name}` : ""} (${where(finding.at)})${labelText(finding.labels)}`, nodeId: finding.id });
      else if (check.key === "screen-policy-differs") {
        items.push({
          text: `${finding.screen}의 정책 ${finding.id} (${where(finding.at)}, 정책 ${where(finding.policyAt)})${labelText(finding.labels)}`,
          nodeId: finding.id,
          more: finding.differences.map((difference) => `${difference.field}: 화면설계서 "${difference.screen}" / 정책 "${difference.policy}"`),
        });
      } else if (check.key === "journey-order-differs")
        items.push({ text: `${finding.id} → ${finding.next}: ${finding.problem} (${where(finding.at)})${labelText(finding.labels)}`, nodeId: finding.id });
    }
    return items;
  }

  function renderChecks(checks) {
    const lines = [WORDS.checks, ""];
    checks.forEach((check, position) => {
      lines.push(`${position + 1}. ${check.heading} — ${check.meaning}`);
      if (check.outcome === "검사 못 함") lines.push(`   검사 못 함: ${check.reason}`);
      else if (check.outcome === "0건") lines.push("   0건");
      else {
        lines.push(`   ${check.findings.length}건`);
        for (const item of findingItems(check)) {
          lines.push(`   - ${item.text}`);
          for (const more of item.more || []) lines.push(`     ${more}`);
        }
      }
      if (check.sideBySide) {
        lines.push(`   제품코어${labelText(check.sideBySide.labels)}`);
        for (const part of check.sideBySide.제품코어)
          lines.push(`     ${part.heading}: ${part.text === null ? "(절 없음)" : part.text.replace(/\s+/g, " ").slice(0, 200)}`);
        lines.push("   정책");
        for (const policy of check.sideBySide.정책) lines.push(`     ${policy.id} (${policy.kind}) 조건: ${policy.조건} / 주체: ${policy.주체} / 행위: ${policy.행위}`);
      }
      lines.push("");
    });
    return lines;
  }

  // The lists of check.txt in its order. Each entry: its heading lines, its
  // items (with the node an item names) and whether items are bounded in the
  // text (the structured result keeps them all).
  function gapLists(result, nodeTypes) {
    const lists = result.lists;
    const entries = [];
    const add = (key, count, head, items = [], { bounded = true, show = true } = {}) => {
      if (show) entries.push({ key, count, head, items, bounded });
    };
    add(
      "missingIds",
      lists.missingIds.length,
      [`문서가 가리키는데 없는 ID: ${lists.missingIds.length}건`],
      lists.missingIds.map((item) => ({ text: `${item.kind} ${item.id} (${where(item.at)})${item.note ? ` — ${item.note}` : ""}${labelText(item.labels)}` })),
    );
    if (lists.unpointedFunctionsReason)
      add("unpointedFunctions", lists.unpointedFunctions.length, [
        `어떤 화면요소·화면도 가리키지 않는 기능: 기능 ${lists.unpointedFunctions.length}개 중 — 검사 못 함: ${lists.unpointedFunctionsReason}`,
      ]);
    else
      add(
        "unpointedFunctions",
        lists.unpointedFunctions.length,
        [`어떤 화면요소·화면도 가리키지 않는 기능: ${lists.unpointedFunctions.length}개`],
        lists.unpointedFunctions.map((id) => ({ text: id, nodeId: id })),
      );
    const unreached = lists.unreachedCode;
    const calls = lists.unresolvedReferences;
    add(
      "unreachedCode",
      unreached.declarations,
      [
        `어느 기능에서도 닿지 않는 코드: 선언 ${unreached.declarations}개 — 풀린 호출 ${calls.resolved} / 전체 ${calls.all}로 따라간 결과다. '닿지 않음'은 풀린 경로를 찾지 못했다는 뜻이고, 죽은 코드라는 뜻이 아니다.`,
        "  처리 코드가 파일 전체인 기능(스크립트, command 파일, 등록 파일 등)은 그 파일과 파일 맨 위의 호출까지 닿은 것으로 본다. 그 파일 안의 선언은 풀린 호출로만 닿는다. 클래스에 닿으면 생성자에 닿은 것으로 본다.",
        `  아무것도 닿지 않는 파일 ${unreached.filesNothingReached}개, 일부만 닿는 파일 ${unreached.filesPartlyReached}개. 많은 파일부터:`,
      ],
      unreached.files.map((file) => ({
        text: file.declarations.length
          ? `${file.path} — 선언 ${file.declarations.length}개${file.nothingReached ? " (파일 전체가 닿지 않음)" : ""}`
          : `${file.path} — 선언 없는 파일, 닿지 않음`,
        nodeId: file.path,
        declarations: file.declarations,
      })),
    );
    add(
      "unresolvedReferences",
      calls.unresolved,
      [`하나로 정하지 못한 호출: ${calls.unresolved}개 (전체 ${calls.all}개 중). 이유별:`],
      calls.byReason.map((reason) => ({ text: `${reason.label}: ${reason.count}개 — 정하려면: ${reason.settle}` })),
      { bounded: false },
    );
    const looked = lists.notLookedAt;
    add("notLookedAt", looked.files, [
      `코드로 읽지 않은 파일(보지 않음): ${looked.files}개${looked.byExtension.length ? ` (${looked.byExtension.map((item) => `${item.extension} ${item.count}`).join(", ")})` : ""}. 테스트로 분류해 코드 층에 넣지 않은 코드 파일 ${looked.testCodeFiles}개, 읽지 못한 코드 파일 ${looked.unreadableCodeFiles}개.`,
      ...(looked.skipped.length ? [`  건너뛴 것: ${looked.skipped.map((item) => `${item.reason} ${item.count}`).join(", ")}`] : []),
    ]);
    add(
      "vanishedMeanings",
      lists.vanishedMeanings.length,
      [`사라진 기능의 뜻: ${lists.vanishedMeanings.length}개`],
      lists.vanishedMeanings.map((item) => ({ text: `${item.id} — "${item.text}" (${where(item.at)})` })),
    );
    add(
      "partlyResolvedRows",
      lists.partlyResolvedRows.length,
      [`표 항목의 일부만 풀린 기능: ${lists.partlyResolvedRows.length}개 (풀린 처리 코드는 그대로 쓰고, 풀리지 않은 부분을 적는다)`],
      lists.partlyResolvedRows.map((item) => ({ text: `${item.id} (${where(item.position)}) — ${item.reason}`, nodeId: item.id })),
      { show: lists.partlyResolvedRows.length > 0 },
    );
    add(
      "multiRowFunctions",
      lists.multiRowFunctions.length,
      [`여러 표 항목에서 나온 기능: ${lists.multiRowFunctions.length}개 (모든 항목의 처리 코드를 함께 쓴다. 언급까지 맞는 패턴이면 규칙을 고친다)`],
      lists.multiRowFunctions.map((item) => ({ text: `${item.id} — ${item.positions.map(where).join(", ")}`, nodeId: item.id })),
      { show: lists.multiRowFunctions.length > 0 },
    );
    add(
      "unresolvedHandlers",
      lists.unresolvedHandlers.length,
      [`처리 코드를 찾지 못한 기능: ${lists.unresolvedHandlers.length}개`],
      lists.unresolvedHandlers.map((item) => ({ text: `${item.id} (${where(item.position)}) — ${item.reason}`, nodeId: item.id })),
    );
    add(
      "notTakenBindings",
      lists.notTakenBindings.length,
      [`기능으로 삼지 않은 연결: ${lists.notTakenBindings.length}개`],
      lists.notTakenBindings.map((item) => ({
        text: `${item.path}:${item.line} ${item.component} ${item.emitter ? `${item.emitter} ` : ""}${item.event} → ${item.target || "(대상 없음)"} — ${item.pattern}`,
      })),
    );
    add(
      "uiWithoutRule",
      lists.uiWithoutRule.length,
      [`화면 코드인데 규칙이 없음: ${lists.uiWithoutRule.length}개`],
      lists.uiWithoutRule.map((item) => ({ text: `${item.path} — ${item.sign}` })),
    );
    add(
      "outOfScope",
      lists.outOfScope.length,
      [`범위 밖으로 둔 입구: ${lists.outOfScope.length}개`],
      lists.outOfScope.map((item) => ({ text: `${item.id} (${where(item.position)})` })),
      { show: lists.outOfScope.length > 0 },
    );
    add(
      "ruleIssues",
      lists.ruleIssues.length,
      [`호출 방식 표 문제: ${lists.ruleIssues.length}개`],
      lists.ruleIssues.map((item) => ({ text: `${item.종류}: ${item.path} — ${item.reason}` })),
      { show: lists.ruleIssues.length > 0 },
    );
    add(
      "counts",
      null,
      ["노드 수:"],
      nodeTypes.map((type) => {
        const count = result.counts[type];
        const usedCount = result.usedCounts[type];
        return { text: `${type} ${count}${typeof usedCount === "number" && usedCount !== count ? ` (검사에 쓴 것 ${usedCount})` : ""}` };
      }),
      { bounded: false },
    );
    add(
      "documents",
      result.documents.list.length,
      ["문서별 상태:"],
      result.documents.list.map((item) => ({
        text: `${item.path} — ${item.status}${item.status !== "승인" ? ` (${item.estimateKind || "어느 쪽 추정인지 적지 않음"}) — 승인할 digest ${item.approvalDigest}` : ""}`,
      })),
    );
    add(
      "formatIssues",
      lists.formatIssues.length,
      [`문서 형식 문제: ${lists.formatIssues.length}개`],
      lists.formatIssues.map((item) => ({ text: `${item.path}:${item.line} ${item.kind}${item.detail ? `: ${item.detail}` : ""}` })),
      { show: lists.formatIssues.length > 0 },
    );
    add(
      "unrecognizedFiles",
      lists.unrecognizedFiles.length,
      [`읽지 않은 파일: ${lists.unrecognizedFiles.length}개`],
      lists.unrecognizedFiles.map((item) => ({ text: item })),
      { show: lists.unrecognizedFiles.length > 0 },
    );
    add(
      "approvalIssues",
      lists.approvalIssues.length,
      [`승인 기록으로 읽지 못한 파일: ${lists.approvalIssues.length}개`],
      lists.approvalIssues.map((item) => ({ text: `${item.path} — ${item.reason}` })),
      { show: lists.approvalIssues.length > 0 },
    );
    return entries;
  }

  function renderGapLists(entries) {
    const lines = [];
    for (const entry of entries) {
      lines.push(...entry.head);
      if (entry.bounded) lines.push(...listLines(entry.items));
      else lines.push(...entry.items.map((item) => `  - ${item.text}`));
    }
    return lines;
  }

  // ---------- the comparison with the baseline (8A) ----------

  const CHANGE_LISTS = Object.freeze([
    { key: "content", title: "실제 전후 내용" },
    { key: "changed", title: "변경" },
    { key: "added", title: "신규" },
    { key: "removed", title: "사라짐" },
    { key: "reachChanged", title: "닿는 코드가 바뀜" },
    { key: "edges", title: "연결의 신규·사라짐" },
    { key: "maybeMoved", title: "옮겨졌을 수 있음" },
    { key: "unexplained", title: "소스가 그대로인 곳에서 달라진 것" },
    { key: "reviewAgain", title: "다시 볼 것" },
  ]);

  // Items of one comparison list, one line each.
  function contentSide(label, side) {
    if (!side || !["available", "partial"].includes(side.status)) return `${label}: ${side?.status === "absent" ? "없음" : `보이지 않음 — ${side?.reason || "이유 없음"}`}`;
    const lines = side.text.split("\n"), shown = lines.slice(0, 40).map((line) => line.slice(0, 240));
    const left = side.omittedBytes ? ` (${side.omittedBytes}바이트 생략: ${side.omittedBecause})` : "";
    return `${label} (${side.format}${side.status === "partial" ? ", 앞부분만" : ""}${left}):\n${shown.join("\n")}${lines.length > 40 ? `\n… ${lines.length - 40}줄 더 — --json의 rows[].detail에 이 페이지 한도 안의 전체가 있다` : ""}`;
  }

  function contentHeadline(item) {
    const read = (side) => { try { return side?.status === "available" && side.format === "stated-fields" ? JSON.parse(side.text) : null; } catch { return null; } };
    const before = read(item.before), after = read(item.after);
    if (!before && !after) return "";
    const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
    return keys.map((key) => `${key}: ${before ? JSON.stringify(before[key] ?? null).slice(0, 240) : "이전 없음"} → ${after ? JSON.stringify(after[key] ?? null).slice(0, 240) : "현재 없음"}`).join("\n");
  }

  // content: the bodies come only with the `changes --list content` question
  // (content holds that page's before/after); without them, each item says how
  // to ask. A page opened from a build has no bodies.
  function changeItems(changes, key, content = null) {
    if (!changes || changes.status !== "compared") return [];
    if (key === "content") return (changes.contentChanges || []).map((item) => {
      const sides = content?.entries?.get(item.id);
      const head = `${item.type} ${item.id} (${CHANGE_WORDS[item.change] || item.change})`;
      if (!sides) return { text: `${head} — 이전 본문 ${item.beforeRetained ? "보관됨" : "없음"}. 본문은 product-graph-query <project> changes --list content 로만 본다.`, nodeId: item.change === "removed" ? null : item.id };
      const detail = { ...item, before: sides.before, after: sides.after };
      const headline = contentHeadline(detail);
      return { text: `${head}${headline ? `\n${headline}` : ""}\n${contentSide("이전", sides.before)}\n${contentSide("현재", sides.after)}`, nodeId: sides.after.status === "absent" ? null : item.id, detail };
    });
    const flat = (field) => (changes.byType || []).flatMap((group) => (group[field] || []).map((id) => ({ text: `${group.type} ${id}`, nodeId: field === "removed" ? null : id })));
    if (key === "changed" || key === "added" || key === "removed") return flat(key);
    if (key === "reachChanged")
      return (changes.reachChanged || []).map((item) => ({
        text: `기능 ${item.id} — ${item.nodes.map((node) => `${node.id} (${CHANGE_WORDS[node.change]})`).join(", ")}${item.total > item.nodes.length ? ` 외 ${item.total - item.nodes.length}개` : ""}`,
        nodeId: item.id,
      }));
    if (key === "edges")
      return [
        ...(changes.edges?.added || []).map((edge) => ({ text: `신규 ${edge.type} ${edge.from} → ${edge.to}`, nodeId: edge.from })),
        ...(changes.edges?.removed || []).map((edge) => ({ text: `사라짐 ${edge.type} ${edge.from} → ${edge.to}` })),
      ];
    if (key === "maybeMoved") return (changes.maybeMoved || []).map((pair) => ({ text: `${pair.type} ${pair.from} → ${pair.to}`, nodeId: pair.to }));
    if (key === "unexplained")
      return [
        ...(changes.unexplained?.nodes || []).map((item) => ({ text: `${CHANGE_WORDS[item.change]} ${item.type} ${item.id}`, nodeId: item.change === "removed" ? null : item.id })),
        ...(changes.unexplained?.edges || []).map((item) => ({ text: `${CHANGE_WORDS[item.change]} ${item.type} ${item.from} → ${item.to}` })),
      ];
    if (key === "reviewAgain") {
      const again = changes.reviewAgain || {};
      return [
        ...(again.meaningLines || []).map((item) => ({ text: `뜻 줄 ${where(item.at)} 기능 ${item.id} — ${CHANGE_WORDS[item.change]}`, nodeId: item.id })),
        ...(again.newWithoutMeaning || []).map((id) => ({ text: `뜻 줄 없음: 신규 기능 ${id}`, nodeId: id })),
        ...(again.documentRows || []).map((item) => ({
          text: `문서 줄 ${where(item.at)} ${item.type} ${item.from} → ${item.to} — ${item.target} ${CHANGE_WORDS[item.change]} (문서 ${item.status})${item.approved ? " — 승인된 문서가 가리키는 것이 기준 뒤 바뀜" : ""}`,
          nodeId: item.target,
        })),
      ];
    }
    return [];
  }

  function changeCount(changes, key) {
    return changeItems(changes, key).length;
  }

  // The block of check.txt right after the limits. Lists are bounded here;
  // check.json keeps them whole.
  function renderChanges(changes) {
    if (!changes) return [];
    const lines = [WORDS.comparison];
    if (changes.status !== "compared") return [...lines, `- 기준 없음 — ${changes.reason}`, ""];
    const moved = changes.moved;
    const parts = [
      `소스 파일 ${moved.sourceFiles}개`,
      `문서 ${moved.documents}개`,
      `호출 방식 표 ${moved.rules ? "바뀜" : "그대로"}`,
      `읽는 방식 ${moved.reader ? "바뀜" : "그대로"}`,
    ];
    lines.push(`- 기준: ${changes.baseline.setAt}에 잡음. 그 뒤 움직인 것: ${parts.join(", ")}.`);
    if (moved.sourceFileList?.length)
      lines.push(`  바뀐 소스 파일: ${moved.sourceFileList.slice(0, 10).join(", ")}${moved.sourceFiles > 10 ? ` 외 ${moved.sourceFiles - 10}개` : ""}`);
    if (moved.documentList?.length) lines.push(`  바뀐 문서: ${moved.documentList.join(", ")}`);
    if (moved.rules || moved.reader) lines.push("- 호출 방식 표나 읽는 방식이 바뀌어, 아래 차이는 제품이 아니라 코드를 읽는 방식에서 왔을 수 있다.");
    lines.push("- 노드 종류별 (ID 기준):");
    for (const group of changes.byType || [])
      lines.push(`  - ${group.type}: 변화 없음 ${group.unchanged}, 변경 ${group.changed.length}, 신규 ${group.added.length}, 사라짐 ${group.removed.length}`);
    const section = (title, items) => {
      lines.push(`- ${title}: ${items.length}개`);
      lines.push(...listLines(items).map((line) => `  ${line}`));
    };
    section("변경", changeItems(changes, "changed"));
    section("신규", changeItems(changes, "added"));
    section("사라짐", changeItems(changes, "removed"));
    section("닿는 코드가 바뀜", changeItems(changes, "reachChanged"));
    const edges = changes.edges || {};
    lines.push(
      `- 연결: call 신규 ${edges.call?.added || 0}, 사라짐 ${edges.call?.removed || 0} · callback 신규 ${edges.callback?.added || 0}, 사라짐 ${edges.callback?.removed || 0}`,
    );
    section("그 밖의 연결 신규·사라짐", changeItems(changes, "edges"));
    section("옮겨졌을 수 있음 (같은 종류·이름·내용 해시. 두 ID는 그대로 둘이다)", changeItems(changes, "maybeMoved"));
    if (changes.unexplained?.compared === false) lines.push(`- 소스가 그대로인 곳에서 달라진 것: 비교하지 않음 — ${changes.unexplained.reason}`);
    else section("소스가 그대로인 곳에서 달라진 것 (원인은 적지 않는다)", changeItems(changes, "unexplained"));
    section("다시 볼 것 (보고만 한다. 문서·뜻 줄·승인은 바꾸지 않는다)", changeItems(changes, "reviewAgain"));
    if (changes.content?.changed)
      lines.push(`- 내용이 바뀐 노드 ${changes.content.changed}개 (이전 본문 보관 ${changes.content.beforeRetained}개). 본문은 여기 넣지 않는다: product-graph-query <project> changes --list content`);
    lines.push("");
    return lines;
  }

  // ---------- confirmation records ----------

  const CONFIRMATION_LISTS = Object.freeze(Object.keys(CHECK_WORDS).map((key) => ({ key, title: CHECK_WORDS[key] })));

  function confirmationItems(confirmations, key) {
    if (!confirmations || confirmations.status !== "compared") return [];
    if (key === "issues") return (confirmations.issues || []).map((issue) => ({ text: `${issue.path} — ${issue.reason} (${issue.code})` }));
    return (confirmations[key] || []).map((item) => {
      const what =
        item.kind === "meaning"
          ? `뜻 줄 ${where(item.at)} 기능 ${item.id}`
          : `문서 줄 ${where(item.at)} ${item.type} ${item.from} → ${item.to}${item.documentStatus ? ` (문서 ${item.documentStatus})` : ""}`;
      const who = item.by ? ` — ${CHECK_BY[item.by] || item.by} ${item.checkedAt}` : "";
      let state = CHECK_WORDS[key];
      if (key === "changedSinceCheck") state += `: ${item.nodes.map((node) => `${node.id} (${CHECK_NODE_WORDS[node.change] || node.change})`).join(", ")}`;
      if (key === "textChanged") state = item.kind === "meaning" ? "확인 뒤 뜻 줄이 바뀜" : "확인 뒤 문서가 바뀜";
      const target = item.kind === "meaning" ? item.id : item.type === "기능→화면요소" ? item.from : item.to;
      return { text: `${what} — ${state}${who}`, nodeId: target };
    });
  }

  // The summary lines of the block (counts, what the records are, a note).
  function confirmationHead(confirmations) {
    if (!confirmations || confirmations.status !== "compared") return confirmations ? [`- 읽지 않음 — ${confirmations.reason}`] : [];
    const lines = [];
    const c = confirmations.counts;
    lines.push(
      `- 확인할 수 있는 뜻 줄·문서 줄 ${c.items}개: 확인 그대로 ${c.current} · 확인한 적 없음 ${c.neverChecked} · 확인 뒤 코드가 바뀜 ${c.changedSinceCheck} · 확인 뒤 글이 바뀜 ${c.textChanged} · 다른 방식으로 읽은 때 확인함 ${c.otherReader}. 확인 기록 ${confirmations.records}개.`,
    );
    lines.push("- 에이전트 확인은 에이전트가 코드를 다시 읽은 기록이고, 사용자 승인은 문서를 승인할 때 함께 남은 기록이다. 어느 것도 권한을 주지 않는다.");
    if (confirmations.note) lines.push(`- ${confirmations.note}`);
    return lines;
  }

  // The block of check.txt after the comparison: what was checked against
  // the code and whether that still holds. Not moved by the baseline.
  function renderConfirmations(confirmations) {
    if (!confirmations) return [];
    const lines = [WORDS.confirmations];
    if (confirmations.status !== "compared") return [...lines, `- 읽지 않음 — ${confirmations.reason}`, ""];
    lines.push(...confirmationHead(confirmations));
    for (const key of ["issues", "changedSinceCheck", "textChanged", "otherReader", "neverChecked"]) {
      const items = confirmationItems(confirmations, key);
      if (key === "issues" && !items.length) continue;
      lines.push(`- ${CHECK_WORDS[key]}${key === "issues" ? " (아무것도 확인한 것으로 치지 않는다)" : ""}: ${items.length}개`);
      lines.push(...listLines(items).map((line) => `  ${line}`));
    }
    lines.push("");
    return lines;
  }

  function confirmationsAnswer(ctx, { list, limit, cursor, answer }) {
    const confirmations = ctx.confirmations;
    const known = CONFIRMATION_LISTS.find((item) => item.key === list);
    if (!confirmations || confirmations.status !== "compared")
      return answer(`확인 기록 — ${known.title}: 비교하지 않음`, [
        { depth: 1, kind: "text", text: `비교하지 않음 — ${confirmations?.reason || "이 빌드에는 확인 기록 비교가 없다(다시 빌드한다)"}` },
      ]);
    const items = confirmationItems(confirmations, list);
    const paged = page(items, { limit, cursor });
    const rows = paged.slice.map((item) => ({ depth: 1, kind: item.nodeId ? "node" : "text", id: item.nodeId || undefined, text: item.text }));
    if (paged.remaining) rows.push(moreRow(1, paged, `changes --list ${list} --cursor ${paged.nextCursor}`));
    return answer(`확인 기록 — ${known.title} ${items.length}개`, rows, {
      page: { total: paged.total, cursor: paged.cursor, limit: paged.limit, remaining: paged.remaining, nextCursor: paged.nextCursor },
    });
  }

  function changesAnswer(ctx, { list, limit, cursor, answer }) {
    const changes = ctx.changes;
    if (!list) {
      const lines = [
        ...renderChanges(changes || { status: "none", reason: "이 빌드에는 기준 비교가 없다" }).slice(1),
        ...renderConfirmations(ctx.confirmations),
      ].filter((line) => line !== "");
      return answer(
        "기준과 비교",
        lines.map((text) => ({ depth: 0, kind: "text", text })),
      );
    }
    if (CONFIRMATION_LISTS.some((item) => item.key === list)) return confirmationsAnswer(ctx, { list, limit, cursor, answer });
    const known = CHANGE_LISTS.find((item) => item.key === list);
    if (!known)
      return fail("PRODUCT_GRAPH_QUERY_INVALID", `모르는 목록: ${list}. 있는 것: ${[...CHANGE_LISTS, ...CONFIRMATION_LISTS].map((item) => item.key).join(", ")}`);
    if (!changes || changes.status !== "compared")
      return answer(`기준과 비교 — ${known.title}: 비교하지 않음`, [
        { depth: 1, kind: "text", text: `비교하지 않음 — ${changes?.reason || "이 빌드에는 기준 비교가 없다"}` },
      ]);
    if (list === "unexplained" && changes.unexplained?.compared === false)
      return answer(`기준과 비교 — ${known.title}: 비교하지 않음`, [{ depth: 1, kind: "text", text: `비교하지 않음 — ${changes.unexplained.reason}` }]);
    const items = changeItems(changes, list, ctx.content);
    const paged = page(items, { limit, cursor });
    const rows = paged.slice.map((item) => ({ depth: 1, kind: item.nodeId ? "node" : "text", id: item.nodeId || undefined, text: item.text, ...(item.detail ? { detail: item.detail } : {}) }));
    if (paged.remaining) rows.push(moreRow(1, paged, `changes --list ${list} --cursor ${paged.nextCursor}`));
    return answer(`기준과 비교 — ${known.title} ${items.length}개`, rows, {
      page: { total: paged.total, cursor: paged.cursor, limit: paged.limit, remaining: paged.remaining, nextCursor: paged.nextCursor },
    });
  }

  function gapsAnswer(ctx, { list, limit, cursor, answer }) {
    const check = ctx.check;
    if (!check) return fail("PRODUCT_GRAPH_NOT_BUILT", "check.json이 없다.");
    const entries = gapLists(check, (ctx.graph?.nodeTypes || []).map((item) => item.type));
    if (!list) {
      const rows = [];
      if (check.guide?.length) {
        rows.push({ depth: 0, kind: "text", text: "처음 쓸 때 — 빠진 입력" });
        for (const item of check.guide) rows.push({ depth: 1, kind: "text", text: `${item.input} (${item.state}). 다음: ${item.next}` });
      }
      rows.push({ depth: 0, kind: "text", text: "제품 그래프 정합성 검사" });
      check.checks.forEach((item, position) => {
        const outcome = item.outcome === "검사 못 함" ? `검사 못 함: ${item.reason}` : item.outcome === "0건" ? "0건" : `${item.findings.length}건`;
        rows.push({ depth: 1, kind: "text", text: `${position + 1}. ${item.heading} — ${outcome}` });
      });
      rows.push({ depth: 0, kind: "text", text: "목록 (gaps --list <key>):" });
      for (const entry of entries) if (entry.key !== "counts") rows.push({ depth: 1, kind: "text", text: `${entry.key}: ${entry.head[0]}` });
      return answer("빈 곳", rows);
    }
    const entry = entries.find((item) => item.key === list);
    if (!entry) {
      const findings = check.checks.find((item) => item.key === list);
      if (!findings) return fail("PRODUCT_GRAPH_QUERY_INVALID", `모르는 목록: ${list}. 있는 것: ${[...entries.map((item) => item.key), ...check.checks.map((item) => item.key)].join(", ")}`);
      const items = findingItems(findings);
      const paged = page(items, { limit, cursor });
      const rows = paged.slice.map((item) => ({ depth: 1, kind: "node", id: item.nodeId, text: item.text }));
      if (paged.remaining) rows.push(moreRow(1, paged, `gaps --list ${list} --cursor ${paged.nextCursor}`));
      return answer(`빈 곳 — ${findings.heading}`, rows, { page: { total: paged.total, cursor: paged.cursor, limit: paged.limit, remaining: paged.remaining, nextCursor: paged.nextCursor } });
    }
    const paged = page(entry.items, { limit, cursor });
    const rows = [...entry.head.slice(1).map((text) => ({ depth: 0, kind: "text", text: text.trim() }))];
    for (const item of paged.slice) rows.push({ depth: 1, kind: item.nodeId ? "node" : "text", id: item.nodeId, text: item.text });
    if (paged.remaining) rows.push(moreRow(1, paged, `gaps --list ${list} --cursor ${paged.nextCursor}`));
    return answer(`빈 곳 — ${entry.head[0]}`, rows, { page: { total: paged.total, cursor: paged.cursor, limit: paged.limit, remaining: paged.remaining, nextCursor: paged.nextCursor } });
  }

  return Object.freeze({
    resolveId,
    WORDS,
    QUESTION_STARTS,
    reachDirection,
    overviewParts,
    childText,
    basisMark,
    LIMIT,
    LIMITS_TITLE,
    CHANGE_WORDS,
    CHANGE_LISTS,
    CONFIRMATION_LISTS,
    CHECK_WORDS,
    index,
    closure,
    reverseClosure,
    handlersOf,
    context,
    nodeLine,
    step,
    reach,
    find,
    search,
    impact,
    ask,
    headerLines,
    pseudoChildren,
    renderLimits,
    renderGuide,
    renderChecks,
    findingItems,
    gapLists,
    renderGapLists,
    renderChanges,
    renderConfirmations,
    confirmationHead,
    confirmationItems,
    changeItems,
    contentHeadline,
    changeCount,
  });
})();

import crypto from "node:crypto";
import path from "node:path";
import { analyzeSourceFile, languageForSource, SOURCE_ANALYSIS_VERSION } from "./source-analysis.mjs";

const sha = text => crypto.createHash("sha256").update(text).digest("hex");

function lineComparison(before, after) {
  const a = before.split("\n"), b = after.split("\n"); let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  // Unique unchanged lines are conservative alignment anchors, not an AST or
  // minimal edit script. Their monotone subsequence avoids a quadratic full-file
  // LCS and lets a later changed island share the display budget with the first.
  const positions = (lines, to) => {
    const map = new Map();
    for (let i = start; i < to; i++) map.set(lines[i], map.has(lines[i]) ? -1 : i);
    return map;
  };
  const aEnd = a.length - end, bEnd = b.length - end;
  const left = positions(a, aEnd), right = positions(b, bEnd), anchors = [];
  for (let i = start; i < aEnd; i++) if (left.get(a[i]) === i && right.get(a[i]) >= 0) anchors.push([i, right.get(a[i])]);
  const tails = [], previous = new Int32Array(anchors.length).fill(-1);
  for (let i = 0; i < anchors.length; i++) {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >>> 1; if (anchors[tails[mid]][1] < anchors[i][1]) low = mid + 1; else high = mid; }
    if (low) previous[i] = tails[low - 1]; tails[low] = i;
  }
  const aligned = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) aligned.push(anchors[i]);
  aligned.reverse(); aligned.push([aEnd, bEnd]);
  let cursorA = start, cursorB = start;
  const ranges = [];
  for (const [nextA, nextB] of aligned) {
    let fromA = cursorA, fromB = cursorB, toA = nextA, toB = nextB;
    while (fromA < toA && fromB < toB && a[fromA] === b[fromB]) { fromA++; fromB++; }
    while (toA > fromA && toB > fromB && a[toA - 1] === b[toB - 1]) { toA--; toB--; }
    if (fromA < toA || fromB < toB) {
      const range = { before: [Math.max(0, fromA - 3), Math.min(a.length, toA + 3)], after: [Math.max(0, fromB - 3), Math.min(b.length, toB + 3)], changedBefore: fromA, changedAfter: fromB };
      const prior = ranges.at(-1);
      if (prior && range.before[0] <= prior.before[1] && range.after[0] <= prior.after[1]) {
        prior.before[1] = range.before[1]; prior.after[1] = range.after[1];
      } else ranges.push(range);
    }
    cursorA = nextA + 1; cursorB = nextB + 1;
  }
  // At most 160 regions can receive a line on each side. When there are more,
  // sample across the entire changed extent, explicitly retaining omissions.
  const selected = ranges.length <= 160 ? ranges : Array.from({ length: 160 }, (_, i) => ranges[Math.floor(i * (ranges.length - 1) / 159)]);
  const excerpt = (lines, range, changedFrom, lineBudget, byteBudget) => {
    const [rangeFrom, rangeTo] = range;
    const from = Math.max(rangeFrom, Math.min(changedFrom, rangeTo - lineBudget));
    const to = Math.min(rangeTo, from + lineBudget), included = [];
    let used = 0, textTruncated = false;
    for (let i = from; i < to; i++) {
      const separator = included.length ? 1 : 0, bytes = Buffer.byteLength(lines[i], "utf8");
      if (used + separator + bytes > byteBudget) {
        // Only a prefix of this exact line is shown. Never split a UTF-8 code
        // point or relabel the next region as adjacent to this source location.
        const available = byteBudget - used - separator;
        if (available > 0) {
          let prefix = "", size = 0;
          for (const char of lines[i]) { const width = Buffer.byteLength(char, "utf8"); if (size + width > available) break; prefix += char; size += width; }
          if (prefix) included.push(prefix);
        }
        textTruncated = true; break;
      }
      included.push(lines[i]); used += separator + bytes;
    }
    return { startLine: from + 1, endLine: from + included.length, text: included.join("\n"),
      omittedLines: rangeTo - rangeFrom - included.length, textTruncated,
      omittedRanges: [[rangeFrom, from], [from + included.length, rangeTo]].filter(([x, y]) => y > x).map(([x, y]) => ({ startLine: x + 1, endLine: y })) };
  };
  const regions = selected.map((range, index) => {
    const lines = Math.floor(160 / selected.length) + (index < 160 % selected.length ? 1 : 0);
    const bytes = Math.floor(32768 / selected.length) + (index < 32768 % selected.length ? 1 : 0);
    return { before: excerpt(a, range.before, range.changedBefore, lines, bytes), after: excerpt(b, range.after, range.changedAfter, lines, bytes) };
  });
  const empty = { startLine: start + 1, endLine: start, text: "", omittedLines: 0, textTruncated: false };
  const coverage = side => ({ includedLines: regions.reduce((sum, region) => sum + Math.max(0, region[side].endLine - region[side].startLine + 1), 0),
    includedBytes: regions.reduce((sum, region) => sum + Buffer.byteLength(region[side].text, "utf8"), 0),
    omittedLines: ranges.reduce((sum, range) => sum + range[side][1] - range[side][0], 0) - regions.reduce((sum, region) => sum + Math.max(0, region[side].endLine - region[side].startLine + 1), 0),
    textTruncated: regions.some(region => region[side].textTruncated) });
  return { kind: "bounded-line-comparison-not-semantic-diff", changed: before !== after,
    before: regions[0]?.before || empty, after: regions[0]?.after || empty, regions,
    coverage: { before: coverage("before"), after: coverage("after"), changedRegionCount: ranges.length, includedRegionCount: regions.length,
      omittedRegionCount: ranges.length - regions.length, maxLinesPerSide: 160, maxBytesPerSide: 32768, alignment: "unique-unchanged-line-anchors-not-minimal-or-semantic-diff" },
    commonPrefixLines: start, commonSuffixLines: end };
}

// A bounded lexical check, not a semantic equivalence or AST claim. Preserve
// every literal and newline. Unsupported slash/template syntax reduces precision.
function commentStripped(text, language, structural = false) {
  let output = "", mode = "code", quote = "", escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    const lineTerminator = c === "\n" || c === "\r" || language !== "python" && (c === "\u2028" || c === "\u2029");
    if (mode === "line") { if (lineTerminator) { output += c; mode = "code"; } continue; }
    if (mode === "block") { if (c === "*" && next === "/") { mode = "code"; i++; } else if (lineTerminator) output += c; continue; }
    if (mode === "string") {
      output += structural && c !== "\n" ? " " : c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) mode = "code";
      continue;
    }
    if (mode === "triple") { output += structural && c !== "\n" ? " " : c; if (text.slice(i, i + 3) === quote.repeat(3)) { output += structural ? "  " : quote.repeat(2); i += 2; mode = "code"; } continue; }
    if (language === "python" && c === "#" || language !== "python" && c === "/" && next === "/") { mode = "line"; if (c === "/") i++; continue; }
    // A block comment separates tokens; deleting it could turn typeof x into
    // typeofx, or + + into ++. Its line terminators also affect JS ASI.
    if (language !== "python" && c === "/" && next === "*") { output += " "; mode = "block"; i++; continue; }
    if (language !== "python" && (c === "/" || c === "`")) return null;
    if (c === "'" || c === '"') {
      quote = c;
      if (language === "python" && text.slice(i, i + 3) === c.repeat(3)) { mode = "triple"; output += structural ? "   " : c.repeat(3); i += 2; continue; }
      mode = "string";
    }
    output += structural && mode === "string" ? " " : c;
  }
  return mode === "code" || mode === "line" ? output : null;
}

function boundedRangeIsolated(text, language, symbol) {
  if (language === "python") {
    const lines = text.split("\n"), indent = (lines[0].match(/^\s*/) || [""])[0].length;
    if (!lines[0].trimEnd().endsWith(":")) return false;
    return !lines.slice(1).some(line => /^\s*#/.test(line) && (line.match(/^\s*/) || [""])[0].length <= indent);
  }
  if (!["function", "class"].includes(symbol.kind)) return false;
  const structure = commentStripped(text, language, true);
  if (structure === null || !/^\s*(?:export\s+)?(?:async\s+)?(?:function|class)\b/.test(structure)) return false;
  const open = structure.indexOf("{"); if (open < 0 || structure.slice(0, open).includes("=")) return false;
  let parens = 0; for (const c of structure.slice(0, open)) { if (c === "(") parens++; if (c === ")") parens--; } if (parens !== 0) return false;
  let depth = 0;
  for (let i = open; i < structure.length; i++) {
    if (structure[i] === "{") depth++;
    else if (structure[i] === "}" && --depth === 0) return /^\s*;?\s*$/.test(structure.slice(i + 1));
  }
  return false;
}

function declarations(version) {
  const language = languageForSource(path.extname(version.path), path.basename(version.path));
  if (!["javascript", "typescript", "python"].includes(language)) return { status: "unsupported-language", items: [] };
  // Obtain boundaries independently for this exact version, never from today's
  // SymbolRevision or from a line number in a different revision.
  const symbols = analyzeSourceFile(version.text, language, path.basename(version.path)).symbols;
  const lines = version.text.split("\n"), safeSyntax = commentStripped(version.text, language) !== null;
  const items = symbols.map(symbol => {
    const sameLine = symbols.some(other => other !== symbol && (other.line === symbol.line || other.endLine === symbol.line && other.scopePath === symbol.scopePath));
    let valid = safeSyntax && !symbol.identityAmbiguous && !sameLine && Number.isInteger(symbol.line) && Number.isInteger(symbol.endLine)
      && symbol.line > 0 && symbol.endLine >= symbol.line && symbol.endLine <= lines.length;
    if (valid) valid = boundedRangeIsolated(lines.slice(symbol.line - 1, symbol.endLine).join("\n"), language, symbol);
    const text = valid ? lines.slice(symbol.line - 1, symbol.endLine).join("\n") : null;
    return { name: symbol.name, qualifiedName: symbol.qualifiedName, kind: symbol.kind, signature: symbol.signature,
      line: symbol.line, endLine: symbol.endLine, rangePrecision: valid ? "independent-bounded-declaration-lines" : "ambiguous-or-unsupported-boundary",
      text, digest: text === null ? null : sha(text), code: text === null ? null : commentStripped(text, language) };
  });
  return { status: "bounded-analysis-not-full-parser", language, analysisVersion: SOURCE_ANALYSIS_VERSION, potentiallyTruncated: symbols.length >= 200, items };
}

// UI/query-private observation. A comparison key is NOT a canonical Symbol ID.
export function compareExactSourceVersions(before, after, projectId) {
  const descriptor = version => version ? { path: version.path, digest: version.digest, basis: version.basis, revisionId: version.revisionId || null,
    ...(version.asset ? { asset: version.asset } : {}) } : null;
  const result = { before: descriptor(before), after: descriptor(after), identity: "exact-file-bytes-not-decision-causality", symbols: [] };
  if (!before || !after) return { ...result, status: "unknown", reasonCode: "EXACT_SOURCE_PAIR_UNAVAILABLE" };
  if (before.projectId !== projectId || after.projectId !== projectId || before.path !== after.path) return { ...result, status: "unknown", reasonCode: "SOURCE_PAIR_IDENTITY_MISMATCH" };
  for (const version of [before, after]) if (typeof version.text === "string" ? sha(version.text) !== version.digest
    : !version.asset || (version.digest ? !version.asset.rawDigestVerified || version.asset.rawDigest !== version.digest : version.asset.rawDigestVerified !== false)) {
    return { ...result, status: "unknown", reasonCode: "SOURCE_PAIR_DIGEST_MISMATCH" };
  }
  if ([before, after].some(version => version.asset?.rawDigestVerified && version.asset.rawDigest !== version.digest)) return { ...result, status: "unknown", reasonCode: "SOURCE_PAIR_DIGEST_MISMATCH" };
  if (before.asset || after.asset) return { ...result, status: "asset-metadata-only", fileBytes: before.digest && after.digest ? before.digest === after.digest ? "unchanged" : "changed" : "unknown",
    payloadComparison: "not-performed", semanticEquivalence: "not-determined", reasonCode: "ASSET_BYTES_ARE_NOT_A_CODE_TEXT_DIFF" };
  const previous = declarations(before), current = declarations(after);
  result.fileBytes = before.digest === after.digest ? "unchanged" : "changed";
  result.diff = lineComparison(before.text, after.text);
  result.analysis = { before: { ...previous, items: undefined }, after: { ...current, items: undefined } };
  const key = symbol => JSON.stringify([symbol.kind, symbol.qualifiedName]);
  const old = new Map(previous.items.map(s => [key(s), s])), next = new Map(current.items.map(s => [key(s), s]));
  result.symbols = [...new Set([...old.keys(), ...next.keys()])].map(comparisonKey => {
    const a = old.get(comparisonKey), b = next.get(comparisonKey);
    let observation = "unknown-boundary";
    if (!a || !b) observation = "unmatched-declaration-not-proven-rename-or-continuity";
    else if (a.digest && b.digest) observation = a.digest === b.digest ? "declaration-bytes-unchanged"
      : a.code !== null && a.code === b.code ? "comment-text-only-difference"
        : a.text.trimEnd() === b.text.trimEnd() ? "trailing-layout-only-difference" : "declaration-bytes-changed";
    const view = symbol => symbol ? { name: symbol.name, qualifiedName: symbol.qualifiedName, line: symbol.line, endLine: symbol.endLine,
      digest: symbol.digest, rangePrecision: symbol.rangePrecision } : null;
    return { comparisonKey, identity: "unique-name-and-scope-comparison-not-canonical-lineage", observation,
      beforeDeclarationCount: previous.items.filter(item => key(item) === comparisonKey).length,
      afterDeclarationCount: current.items.filter(item => key(item) === comparisonKey).length,
      before: view(a), after: view(b), locationChanged: Boolean(a && b && (a.line !== b.line || a.endLine !== b.endLine)),
      behaviorChanged: "not-determined", decisionCause: "not-inferred" };
  });
  return { ...result, status: "observed", semanticEquivalence: "not-determined", renameContinuity: "not-inferred" };
}

#!/usr/bin/env node
// Stage 3-E codemod: move scripts/lib modules into their layer directories
// (scripts/lib-layers.json) and rewrite every path that names them. One-shot:
// run once on a clean tree with `--write`; without it, it prints the plan.
//
// Paths rewritten:
//   - relative string literals in a path position of tracked JavaScript (an
//     import/export specifier, import(), require(), new URL(…, import.meta.url),
//     or the first path after import.meta.dirname or
//     path.dirname(fileURLToPath(import.meta.url))) that resolve to a tracked
//     file or directory: re-resolved from the file's new directory to the
//     target's new location. Relative-looking values elsewhere (such as a
//     path-escape check `relative.startsWith("../")`) are left alone and
//     reported when they would name a moved file;
//   - the split form path.resolve(path.dirname(fileURLToPath(import.meta.url)),
//     "..", "..") in a moved file gains one "..";
//   - root-relative "scripts/lib/<name>" in tracked JavaScript, JSON and docs, and
//     the segment form "scripts", "lib", "<name>".
// Template literals with substitutions are never rewritten; they are listed.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..", "..");
const write = process.argv.includes("--write");
const table = JSON.parse(fs.readFileSync(path.join(root, "scripts/lib-layers.json"), "utf8"));
const lib = "scripts/lib";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const tracked = git("ls-files").trim().split("\n");
const trackedSet = new Set(tracked);
const trackedDirs = new Set(
  tracked.flatMap((file) =>
    file
      .split("/")
      .slice(0, -1)
      .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
  ),
);
trackedDirs.add("");

export function targetOf(name, { order, pinned, modules } = table) {
  const layer = modules[name];
  if (!order.includes(layer)) throw new Error(`No layer for scripts/lib/${name}`);
  if (pinned.includes(name) || name.startsWith(`${layer}/`)) return name;
  return `${layer}/${name}`;
}

const libFiles = tracked.filter((file) => file.startsWith(`${lib}/`)).map((file) => file.slice(lib.length + 1));
const unknown = libFiles.filter((name) => !Object.hasOwn(table.modules, name));
const stale = Object.keys(table.modules).filter((name) => !libFiles.includes(name));
if (unknown.length || stale.length) throw new Error(`Layer table differs from the tree. Unlisted: ${unknown.join(", ")}; stale: ${stale.join(", ")}`);
const moves = new Map(libFiles.map((name) => [`${lib}/${name}`, `${lib}/${targetOf(name)}`]).filter(([from, to]) => from !== to));
const newPath = (file) => moves.get(file) ?? file;

const posix = path.posix;
// A quoted relative path; `group` is the number of its quote group.
const quoted = (group) => "([\"'`])(\\.\\.?\\/(?:(?!\\" + group + ")[^\\\\\\n$])*)\\" + group;
const spec = quoted(2);
// Only string literals in a path position are rewritten. A relative-looking
// string elsewhere (for example a path-escape check such as
// `relative.startsWith("../")`) is a value, not a path, and stays as it is.
const pathPositions = [
  new RegExp(String.raw`(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)${spec}`, "g"),
  new RegExp(String.raw`(\bnew URL\(\s*)${spec}(?=\s*,\s*import\.meta\.url)`, "g"),
  new RegExp(String.raw`((?:import\.meta\.dirname|path\.dirname\(fileURLToPath\(import\.meta\.url\)\))\s*,\s*)${spec}`, "g"),
];
const computed = [];
const changes = new Map();

function relocate(file, value) {
  const oldTarget = posix.normalize(posix.join(posix.dirname(file), value)).replace(/\/$/, "");
  const isFile = trackedSet.has(oldTarget);
  if (!isFile && !trackedDirs.has(oldTarget === "." ? "" : oldTarget)) return value;
  const target = isFile ? newPath(oldTarget) : oldTarget === "." ? "" : oldTarget;
  let next = posix.relative(posix.dirname(newPath(file)), target) || ".";
  if (!next.startsWith(".")) next = `./${next}`;
  if (value.endsWith("/") && !next.endsWith("/")) next += "/";
  return next;
}

function rewriteRelative(file, text) {
  let out = text;
  for (const position of pathPositions) out = out.replace(position, (whole, head, quote, value) => `${head}${quote}${relocate(file, value)}${quote}`);
  return out;
}

// A relative literal outside a path position that resolves to a moved file is
// reported for review; it is not rewritten.
const unrewritten = [];
function reportRelative(file, text) {
  for (const match of text.matchAll(new RegExp(quoted(1), "g"))) {
    const target = posix.normalize(posix.join(posix.dirname(file), match[2]));
    if (moves.has(target) && relocate(file, match[2]) !== match[2]) unrewritten.push(`${file}: ${match[0]}`);
  }
}

function rewriteSplitResolve(file, text) {
  if (!moves.has(file)) return text;
  const depth = newPath(file).split("/").length - file.split("/").length;
  if (depth <= 0) return text;
  return text.replace(/(import\.meta\.(?:url|dirname)\)*,\s*)((?:"\.\.",\s*)+"\.\.")/g, (whole, head, ups) => `${head}${'"..", '.repeat(depth)}${ups}`);
}

function rewriteRootRelative(text) {
  let out = text.replace(/scripts\/lib\/((?:[a-z0-9-]+\/)?[a-z0-9-]+)(\.mjs|\.json|\.txt)?\b/g, (whole, stem, ext) => {
    const candidates = ext ? [`${stem}${ext}`] : [`${stem}.mjs`];
    const found = candidates.find((name) => moves.has(`${lib}/${name}`));
    return found ? `${moves.get(`${lib}/${found}`)}`.replace(/\.mjs$/, ext ? ".mjs" : "") : whole;
  });
  out = out.replace(/(["'])scripts\1,\s*(["'])lib\2,\s*(["'])([a-z0-9-]+\.(?:mjs|json|txt))\3/g, (whole, q1, q2, q3, name) => {
    const moved = moves.get(`${lib}/${name}`);
    if (!moved) return whole;
    const layer = moved.split("/")[2];
    return `${q1}scripts${q1}, ${q2}lib${q2}, ${q2}${layer}${q2}, ${q3}${name}${q3}`;
  });
  return out;
}

const javascript = /\.(mjs|cjs|js)$/;
const textual = /\.(mjs|cjs|js|json|md)$/;
for (const file of tracked) {
  if (!textual.test(file) || /^CHANGELOG(\.ko)?\.md$/.test(file) || file === "scripts/lib-layers.json") continue;
  const before = fs.readFileSync(path.join(root, file), "utf8");
  let after = before;
  if (javascript.test(file)) {
    for (const match of before.matchAll(/(?:import\(|require\(|new URL\()\s*`[^`]*\$\{/g)) computed.push(`${file}: ${match[0]}`);
    after = rewriteSplitResolve(file, rewriteRelative(file, after));
  }
  after = rewriteRootRelative(after);
  if (javascript.test(file)) reportRelative(file, after);
  if (after !== before) changes.set(file, after);
}

// Paths built from a module name at run time, rewritten by name.
const layered = (name) => targetOf(`${name}.mjs`).replace(/\.mjs$/, "");
const explicit = [
  [
    "test/product-operating-projection.test.mjs",
    'for (const name of ["world-model", "temporal-provenance"])',
    `for (const name of ["${layered("world-model")}", "${layered("temporal-provenance")}"])`,
  ],
  ...[
    "onboarding-projection",
    "product-policy-projection",
    "feature-mapping-projection",
    "change-set-projection",
    "document-change-projection",
    "observation-projection",
    "product-operating-projection",
    "release-observation-projection",
  ].map((name) => ["test/world-domain-freshness.test.mjs", `, "${name}", "load`, `, "${layered(name)}", "load`]),
  // The dispatch recorder names a module by its file name, not its layer path,
  // so the recordings and the pass-through list stay as they are.
  [
    "test/helpers/dispatch-recording-hooks.mjs",
    'const module = real.slice(libUrl.length).replace(/\\.mjs$/, "");',
    'const module = real.slice(libUrl.length).replace(/\\.mjs$/, "").replace(/^.*\\//, "");',
  ],
  // A comment that names its sibling by relative path.
  ["scripts/lib/storage/artifact-storage.mjs", "// Moved to ./core/fs-atomic.mjs;", "// Moved to ../core/fs-atomic.mjs;"],
];
for (const [file, from, to] of explicit) {
  const text = changes.get(file) ?? fs.readFileSync(path.join(root, file), "utf8");
  if (text.split(from).length !== 2) throw new Error(`Explicit rewrite not found exactly once in ${file}: ${from}`);
  changes.set(file, text.replace(from, to));
}

console.log(`moves: ${moves.size}; files with path edits: ${changes.size}`);
if (computed.length) console.log(`computed specifiers (not rewritten):\n${computed.join("\n")}`);
if (unrewritten.length) console.log(`relative values outside a path position (not rewritten):\n${unrewritten.join("\n")}`);
if (!write) {
  for (const [from, to] of moves) console.log(`${from} -> ${to}`);
  process.exit(0);
}
for (const [file, text] of changes) fs.writeFileSync(path.join(root, file), text);
for (const [from, to] of moves) {
  fs.mkdirSync(path.join(root, posix.dirname(to)), { recursive: true });
  git("mv", from, to);
}

#!/usr/bin/env node
// The scripts/lib layer rule (scripts/lib-layers.json): a module may import a
// module of its own layer or a lower one. Imports that point upward today are
// recorded in test/fixtures/lib-layer-baseline.json, which may only shrink:
// test/lib-layers.test.mjs fails on a new upward import, on a new static cycle,
// and on a recorded entry that no longer exists. Regenerate the file with
// `node scripts/lib-layer-baseline.mjs --write` after removing an upward
// import; `--check` compares without writing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const libRoot = path.join(pluginRoot, "scripts", "lib");
export const LAYER_TABLE_FILE = path.join(pluginRoot, "scripts", "lib-layers.json");
export const BASELINE_FILE = path.join(pluginRoot, "test", "fixtures", "lib-layer-baseline.json");

export function readLayerTable() {
  return JSON.parse(fs.readFileSync(LAYER_TABLE_FILE, "utf8"));
}

// Where the table puts a scripts/lib file, relative to scripts/lib.
export function layerPath(name, table = readLayerTable()) {
  const layer = table.modules[name];
  if (!table.order.includes(layer)) throw new Error(`No layer for scripts/lib/${name}`);
  return table.pinned.includes(name) || name.startsWith(`${layer}/`) ? name : `${layer}/${name}`;
}

const staticImport = /(?:^|[\s;])(?:import\s+(?:[^"'`;]*?\s+from\s+)?|export\s+[^"'`;]*?\s+from\s+)["'](\.{1,2}\/[^"']+)["']/g;
const dynamicImport = /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

// Every scripts/lib module with its static and dynamic relative imports inside
// scripts/lib, keyed by path relative to scripts/lib (posix separators).
export function libImportGraph() {
  const files = fs
    .readdirSync(libRoot, { recursive: true })
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => file.endsWith(".mjs"))
    .sort();
  const known = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const source = fs.readFileSync(path.join(libRoot, file), "utf8");
    const resolve = (specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    const pick = (pattern) =>
      [...new Set([...source.matchAll(pattern)].map((match) => resolve(match[1] ?? match[2])).filter((target) => known.has(target)))].sort();
    graph.set(file, { static: pick(staticImport), dynamic: pick(dynamicImport) });
  }
  return graph;
}

function layerOf(file, table) {
  const name = path.posix.basename(file);
  const key = Object.hasOwn(table.modules, name) ? name : file;
  return table.modules[key];
}

function stronglyConnected(graph) {
  let counter = 0;
  const index = new Map(),
    low = new Map(),
    stack = [],
    active = new Set(),
    components = [];
  const visit = (node) => {
    index.set(node, counter);
    low.set(node, counter++);
    stack.push(node);
    active.add(node);
    for (const next of graph.get(node).static) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (active.has(next)) low.set(node, Math.min(low.get(node), index.get(next)));
    }
    if (low.get(node) !== index.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      active.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || graph.get(node).static.includes(node)) components.push(component.sort());
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}

// The current state of the rule: upward imports and static cycles.
export function layerState(table = readLayerTable(), graph = libImportGraph()) {
  const rank = (file) => table.order.indexOf(layerOf(file, table));
  const upward = (kind) =>
    [...graph].flatMap(([file, edges]) => edges[kind].filter((target) => rank(target) > rank(file)).map((target) => `${file} -> ${target}`)).sort();
  return {
    staticUpward: upward("static"),
    dynamicUpward: upward("dynamic"),
    staticCycles: stronglyConnected(graph).map((component) => component.join(" <-> ")),
  };
}

// Where the tree differs from the table: files outside their layer directory,
// files the table does not list, and listed files that do not exist.
export function placementProblems(table = readLayerTable()) {
  const files = fs
    .readdirSync(libRoot, { recursive: true })
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => fs.statSync(path.join(libRoot, file)).isFile());
  const expected = new Map(Object.keys(table.modules).map((name) => [layerPath(name, table), name]));
  return [
    ...files.filter((file) => !expected.has(file)).map((file) => `not where the layer table puts it: scripts/lib/${file}`),
    ...[...expected.keys()].filter((file) => !files.includes(file)).map((file) => `listed but missing: scripts/lib/${file}`),
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const state = layerState();
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (process.argv.includes("--write")) fs.writeFileSync(BASELINE_FILE, text);
  else if (process.argv.includes("--check") && fs.readFileSync(BASELINE_FILE, "utf8") !== text) {
    process.stderr.write("test/fixtures/lib-layer-baseline.json differs from the tree.\n");
    process.exitCode = 1;
  }
  process.stdout.write(
    `${JSON.stringify({ staticUpward: state.staticUpward.length, dynamicUpward: state.dynamicUpward.length, staticCycles: state.staticCycles.length, placementProblems: placementProblems().length })}\n`,
  );
}

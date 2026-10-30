import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Concrete personal home directories. Template owners (`$USER`, `%USERNAME%`,
// `<user>`) stay portable and are not findings. This does not treat every
// absolute path as personal: project identity still records its own root.
const HOME_PATH = /(?:^|[\s"'`(\[{=,:;])(?:file:\/\/)?(?:[A-Za-z]:[\\/]+Users[\\/]+|\/(?:Users|home)\/)([^\s\\/"'<>`{}\[\]():;]+)[\\/]+/giu;
const TEMPLATE_OWNER = /^(?:%[^%]+%|\$[A-Za-z_][A-Za-z0-9_]*|<[^>\s]+>|\{[A-Za-z_][A-Za-z0-9_]*\})$/u;

export const TRACKED_HOME_PATH_ALLOWLIST = Object.freeze([
  // Negative fixtures for the marketplace checker. They are test inputs, not
  // generated client configuration.
  "test/lode-distribution-content.test.mjs",
]);

export function concreteHomePathOwners(text) {
  if (typeof text !== "string" || !text) return [];
  const owners = [];
  for (const match of text.matchAll(HOME_PATH)) {
    if (!TEMPLATE_OWNER.test(match[1])) owners.push(match[1]);
  }
  return owners;
}

export function hasConcreteHomePath(text) {
  return concreteHomePathOwners(text).length > 0;
}

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  return files;
}

export function findHomePathFindings({ root, files = null, allowlist = [] } = {}) {
  const allowed = new Set(allowlist.map(file => file.replaceAll("\\", "/")));
  const selected = files || walkFiles(root).map(file => path.relative(root, file));
  const findings = [];
  for (const relative of selected) {
    const normalized = relative.replaceAll("\\", "/");
    if (allowed.has(normalized)) continue;
    const absolute = path.join(root, ...normalized.split("/"));
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    let text;
    try { text = fs.readFileSync(absolute, "utf8"); }
    catch { continue; }
    if (hasConcreteHomePath(text)) findings.push(normalized);
  }
  return findings.sort();
}

export function trackedFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  return output.split("\0").filter(Boolean);
}

const ABSOLUTE_LAUNCH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

export function absoluteLaunchValues(value, found = []) {
  if (typeof value === "string") {
    if (ABSOLUTE_LAUNCH.test(value)) found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) absoluteLaunchValues(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) absoluteLaunchValues(item, found);
  }
  return found;
}

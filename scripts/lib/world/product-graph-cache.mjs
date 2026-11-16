// Disposable parse work, never authority or a historical source archive.
// Every hit requires freshly read exact source bytes and the actual reader
// dependency bytes. Resolution/check contributions reuse exact dependency
// facts and pass-entry state; global changes fall back and approvals reverify.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serialize, deserialize } from "node:v8";
import { sha256Hex } from "../core/digest.mjs";

export const PRODUCT_GRAPH_CACHE_FILE = "parse-cache.json";
const MAX_BYTES = 64 * 1024 * 1024;

function readParserIdentity() {
  const seen = new Map();
  const visit = (url) => {
    const name = fileURLToPath(url);
    if (seen.has(name)) return;
    const bytes = fs.readFileSync(name),
      text = bytes.toString("utf8");
    seen.set(name, sha256Hex(bytes));
    for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+\.m?js)["']/g)) visit(new URL(match[1], url));
  };
  visit(new URL("./product-graph-extraction.mjs", import.meta.url));
  visit(new URL("./product-graph.mjs", import.meta.url));
  visit(import.meta.url);
  return sha256Hex(
    JSON.stringify([...seen].map(([name, hash]) => [path.relative(fileURLToPath(new URL("..", import.meta.url)), name).replaceAll("\\", "/"), hash]).sort()),
  );
}

// Bind to this loaded implementation, not a future on-disk edit underneath a
// running host. A new process/plugin load observes a new dependency identity.
const LOADED_PARSER_IDENTITY = readParserIdentity();
export const parserIdentity = () => LOADED_PARSER_IDENTITY;
const signature = (value) =>
  sha256Hex(
    JSON.stringify(value, (_, item) => {
      if (item instanceof Map) return { $map: [...item] };
      if (item instanceof Set) return { $set: [...item] };
      if (item && !Array.isArray(item) && typeof item === "object")
        return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      return item;
    }),
  );

export function openParseCache(file, rules) {
  const identity = sha256Hex(JSON.stringify({ parser: parserIdentity(), v8: process.versions.v8, rules }));
  let previous = new Map(),
    reason = "missing";
  if (file)
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("invalid cache file");
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      if (stored.kind !== "ProductGraphParseCache" || stored.identity !== identity || sha256Hex(stored.payload) !== stored.sha256)
        throw new Error("cache identity/integrity changed");
      previous = new Map(JSON.parse(stored.payload));
      reason = "available";
    } catch (error) {
      reason = error.code === "ENOENT" ? "missing" : "invalidated";
    }
  const next = new Map(),
    stats = { reason, parsedFiles: 0, reusedFiles: 0, verifiedSourceBytes: 0, removedCacheEntries: 0 };
  return {
    stats,
    signature,
    getWork(key, signature) {
      const record = previous.get(`\0${key}`);
      if (!record || record.signature !== signature) return null;
      try {
        const value = deserialize(Buffer.from(record.analysis, "base64"));
        next.set(`\0${key}`, record);
        return value;
      } catch {
        return null;
      }
    },
    putWork(key, signature, value) {
      next.set(`\0${key}`, { signature, analysis: serialize(value).toString("base64") });
    },
    get(relative, rawSha256) {
      const record = previous.get(relative);
      if (!record || record.rawSha256 !== rawSha256) return null;
      try {
        const value = deserialize(Buffer.from(record.analysis, "base64"));
        if (!value || !Array.isArray(value.symbols) || !value.facts || !value.semanticFacts) return null;
        next.set(relative, record);
        stats.reusedFiles += 1;
        return value;
      } catch {
        return null;
      }
    },
    put(relative, rawSha256, analysis) {
      // The input text is re-read, never retained as a source snapshot.
      const { text, prepared, boundNames, ...facts } = analysis;
      next.set(relative, { rawSha256, analysis: serialize(facts).toString("base64") });
      stats.parsedFiles += 1;
    },
    serialize() {
      stats.removedCacheEntries = [...previous.keys()].filter((key) => !next.has(key)).length;
      const payload = JSON.stringify([...next]);
      const value = JSON.stringify({ kind: "ProductGraphParseCache", identity, sha256: sha256Hex(payload), payload }) + "\n";
      return Buffer.byteLength(value) <= MAX_BYTES ? value : null;
    },
  };
}

import crypto from "node:crypto";
import { canonicalJson } from "./canonical-json.mjs";

// SHA-256 helpers. Each keeps the exact input bytes of the local helpers it
// replaced: strings hash as UTF-8 and Buffers/typed arrays hash as given.

// Exactly one argument is used, so `values.map(sha256Hex)` stays safe.
export function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// SHA-256 of JSON.stringify(value) (no key sorting).
export function sha256Json(value) {
  return sha256Hex(JSON.stringify(value));
}

// SHA-256 of canonicalJson(value) (recursively sorted object keys).
export function sha256CanonicalJson(value) {
  return sha256Hex(canonicalJson(value));
}

// Incremental hashing (several update() calls, streams, other algorithms such as
// Git object ids). Returns the node:crypto Hash object unchanged.
export function createHasher(algorithm) {
  return crypto.createHash(algorithm);
}

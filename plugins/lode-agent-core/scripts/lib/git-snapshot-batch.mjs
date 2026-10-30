import crypto from "node:crypto";

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };
const oidPattern = /^[a-f0-9]{64}$/;

// Private SHA256 snapshot protocol decoder. It owns only the current request's
// frames; no subprocess, path, authority, persistent cache or effect lives here.
export function createSnapshotBatchDecoder(requests) {
  let index = 0, header = Buffer.alloc(0), body = null, remaining = 0, digest, chunks, finished = false;
  const results = [];
  for (const item of requests) if (!oidPattern.test(item.oid) || !["blob", "tree"].includes(item.type)) fail("SNAPSHOT_GIT_OBJECT_ID_INVALID");
  function push(bytes) {
    if (finished) fail("SNAPSHOT_GIT_BATCH_INVALID");
    let offset = 0;
    while (offset < bytes.length) {
      if (index >= requests.length) fail("SNAPSHOT_GIT_BATCH_INVALID");
      const request = requests[index];
      if (!body) {
        const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
        if (header.length + end - offset > 256) fail("SNAPSHOT_GIT_BATCH_INVALID");
        header = Buffer.concat([header, bytes.subarray(offset, end)]); offset = end;
        if (newline < 0) return;
        offset++;
        const line = header.toString("utf8"); header = Buffer.alloc(0);
        if (line === request.oid + " missing") fail("SNAPSHOT_GIT_COMMAND_FAILED", { gitAction: "cat-file", gitMissingObject: true, gitBatchHeader: line });
        const match = /^([a-f0-9]{64}) (blob|tree|commit|tag) ([0-9]+)$/.exec(line);
        if (!match || match[1] !== request.oid) fail("SNAPSHOT_GIT_BATCH_INVALID");
        if (match[2] !== request.type) fail("SNAPSHOT_GIT_OBJECT_TYPE_MISMATCH");
        const size = Number(match[3]), maximum = typeof request.maximum === "function" ? request.maximum() : request.maximum;
        if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(maximum) || maximum < 0 || size > maximum) fail("SNAPSHOT_STORAGE_LIMIT");
        body = { size }; remaining = size; chunks = [];
        digest = crypto.createHash("sha256").update(Buffer.from(request.type + " " + size + "\0"));
      }
      if (remaining) {
        const count = Math.min(remaining, bytes.length - offset), part = bytes.subarray(offset, offset + count);
        if (count) { digest.update(part); chunks.push(Buffer.from(part)); remaining -= count; offset += count; }
        if (remaining || offset === bytes.length) return;
      }
      if (offset === bytes.length) return;
      if (bytes[offset++] !== 10) fail("SNAPSHOT_GIT_BATCH_INVALID");
      if (digest.digest("hex") !== request.oid) fail("SNAPSHOT_GIT_OBJECT_DIGEST_MISMATCH");
      const complete = Buffer.concat(chunks, body.size);
      request.onObject?.(complete);
      results.push(complete); index++; body = null; chunks = null; digest = null;
    }
  }
  return { push, finish() {
    if (finished || index !== requests.length || header.length || body) fail("SNAPSHOT_GIT_BATCH_TRUNCATED");
    finished = true; return results;
  } };
}

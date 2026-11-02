import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { nativeSqlitePath } from "../scripts/lib/codex-native-backup.mjs";
import {
  CODEX_NATIVE_MAX_FRAME_BYTES,
  inspectCodexRolloutOriginal,
} from "../scripts/lib/codex-native-rollout.mjs";
import { captureCodexNativeHistory } from "../scripts/lib/codex-native-capture.mjs";
import { prepareCodexNativeOffline } from "../scripts/lib/codex-native-offline.mjs";
import { inspectCodexNativePayload } from "../scripts/lib/codex-native-payload.mjs";
import { publishCodexNativeHistory } from "../scripts/lib/codex-native-publication.mjs";
import { syntheticNativeCapture, nativeProfile } from "./helpers/native-portability-fixture.mjs";

test("actual frame limit preserves exact raw bytes while hidden following frames and native qualification remain unverified", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64")
    return t.skip("Measured native filesystem profile is Windows x64.");
  const { f, home, executable, payload } = await syntheticNativeCapture(t);
  const entry = payload.files[0],
    source = path.join(home, entry.path),
    original = fs.readFileSync(source),
    header = original.subarray(0, original.indexOf(10) + 1);
  const sha = crypto.createHash("sha256"),
    fd = fs.openSync(source, "w");
  let total = 0;
  const write = (chunk) => {
    for (let offset = 0; offset < chunk.length; ) {
      const written = fs.writeSync(fd, chunk, offset, chunk.length - offset);
      assert(written > 0);
      sha.update(chunk.subarray(offset, offset + written));
      total += written;
      offset += written;
    }
  };
  try {
    write(header);
    write(Buffer.from('{"ordinal":1,"type":"response_item","payload":{"text":"'));
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let remaining = CODEX_NATIVE_MAX_FRAME_BYTES + 1; remaining > 0; ) {
      const length = Math.min(remaining, chunk.length);
      write(chunk.subarray(0, length));
      remaining -= length;
    }
    // This invalid following ordinal must not be declared verified merely
    // because the earlier giant frame exhausted the current decoder.
    write(
      Buffer.from('"}}\n{"ordinal":99,"type":"response_item","payload":{"unverified":true}}\n'),
    );
  } finally {
    fs.closeSync(fd);
  }
  const expectedHash = sha.digest("hex");
  const db = new DatabaseSync(nativeSqlitePath(path.join(home, "thread_history_1.sqlite")));
  try {
    db.prepare(
      "UPDATE thread_turns SET rollout_end_ordinal=2,rollout_end_byte_offset=? WHERE thread_id=?",
    ).run(BigInt(total), entry.threadId);
    db.prepare(
      "UPDATE thread_history_projection_state SET next_rollout_byte_offset=?,next_rollout_ordinal=3 WHERE thread_id=?",
    ).run(BigInt(total), entry.threadId);
  } finally {
    db.close();
  }
  const offline = await prepareCodexNativeOffline({
    home,
    executable,
    probe: async () => ({ status: "observed", rows: [] }),
    versionProbe: async () => ({ status: "verified", version: nativeProfile.engineVersion }),
  });
  const captured = await captureCodexNativeHistory({
    witness: offline.witness,
    threadIds: [entry.threadId],
    destination: path.join(f.base, "large-native"),
  });
  assert.equal(captured.status, "captured-partial-native-originals");
  const read = inspectCodexNativePayload({ directory: captured.directory });
  assert.equal(read.mechanicalOriginalsReady, false);
  assert.equal(read.nativePublicationReady, false);
  assert.equal(read.payload.files[0].sha256, expectedHash);
  assert.equal(read.payload.files[0].bytes, total);
  assert(read.coverage[0].unresolvedClosure.includes("following-frame-boundaries-unverified"));
  assert.equal(
    fs.statSync(path.join(captured.directory, "objects", expectedHash + ".bin")).size,
    total,
  );
  const publication = await publishCodexNativeHistory({
    witness: Object.freeze({}),
    directory: captured.directory,
  });
  assert.equal(publication.status, "native-originals-partial");
  assert.equal(publication.persisted, false);
  const changed = structuredClone(read.payload.history),
    table = changed.tables.find((row) => row.name === "thread_history_projection_state"),
    column = table.columns.indexOf("next_rollout_byte_offset");
  table.rows[0][column] = { type: "integer", value: String(total + 1) };
  assert.throws(
    () =>
      inspectCodexRolloutOriginal({
        root: home,
        relative: entry.path,
        threadId: entry.threadId,
        history: changed,
      }),
    { code: "NATIVE_CODEX_CUTOFF_MISMATCH" },
  );
  const denied = Object.assign(Error("Synthetic denial with a coincident code"), {
    code: "NATIVE_CODEX_FRAME_TOO_LARGE",
  });
  assert.throws(
    () =>
      inspectCodexRolloutOriginal({
        root: home,
        relative: entry.path,
        threadId: entry.threadId,
        history: read.payload.history,
        assertCurrentAuthority() {
          throw denied;
        },
      }),
    (error) => error === denied,
    "a caller failure is never a branded decoder fallback",
  );
});

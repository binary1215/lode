import { operateProjectNativeHistory } from "../scripts/lib/project-native-history.mjs";
import { assertProjectNativeTransferCurrent } from "../scripts/lib/project-native-transfer.mjs";
import { syntheticNativeCapture } from "./helpers/native-portability-fixture.mjs";
import {
  attachProjectNativeTransfer,
  readProjectNativeTransfer,
} from "../scripts/lib/project-native-transfer.mjs";
import {
  exportProjectBundle,
  inspectProjectBundle,
  importProjectBundle,
} from "../scripts/lib/project-portability.mjs";
import { pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { requestNativeRegistration } from "../scripts/lib/native-registration-journal.mjs";
import { publishCodexNativeHistory } from "../scripts/lib/codex-native-publication.mjs";
import {
  inspectCodexNativePayload,
  codexNativePayloadSummary,
} from "../scripts/lib/codex-native-payload.mjs";
import {
  planCodexNativeRowMerge,
  applyCodexNativeRowMerge,
} from "../scripts/lib/codex-native-row-merge.mjs";
import { captureCodexNativeHistory } from "../scripts/lib/codex-native-capture.mjs";
import {
  observeCodexNativeWriters,
  prepareCodexNativeOffline,
  assertCodexNativeOffline,
  codexNativeOfflineProcessStatus,
} from "../scripts/lib/codex-native-offline.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, snapshot } from "./helpers/session-work-linkage-fixture.mjs";
import { inspectProject } from "../scripts/lib/lode-core.mjs";
import crypto from "node:crypto";
import {
  createCodexRolloutVerifier,
  verifyCodexRollout,
} from "../scripts/lib/codex-native-rollout.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  inspectCodexNativeDatabase,
  readSelectedCodexHistory,
} from "../scripts/lib/codex-native-portability.mjs";
import {
  encodeSqliteCell,
  decodeSqliteCell,
  readTypedSqliteRows,
} from "../scripts/lib/native-sqlite-values.mjs";
import {
  nativeProfile,
  profileBasis,
  syntheticNativeDatabase,
  syntheticNativeHistory,
} from "./helpers/native-portability-fixture.mjs";

test("native SQLite cell export preserves actual int64/REAL/TEXT/BLOB/NULL types without source changes", (t) => {
  const source = new DatabaseSync(":memory:"),
    target = new DatabaseSync(":memory:");
  t.after(() => {
    source.close();
    target.close();
  });
  source.exec(
    "CREATE TABLE cells (v); CREATE TABLE retained (v TEXT); INSERT INTO retained VALUES ('unrelated');",
  );
  target.exec(
    "CREATE TABLE cells (v); CREATE TABLE retained (v TEXT); INSERT INTO retained VALUES ('target-owned');",
  );
  const values = [
    -9223372036854775808n,
    9223372036854775807n,
    Number.POSITIVE_INFINITY,
    1.25,
    "\uFEFF한글\0exact",
    Buffer.from([0, 255, 128]),
    null,
  ];
  const insert = source.prepare("INSERT INTO cells VALUES (?)");
  for (const value of values) insert.run(value);
  const before = source
    .prepare("SELECT typeof(v) AS type, hex(CAST(v AS BLOB)) AS raw FROM cells")
    .all();
  const rows = readTypedSqliteRows(source, "cells", ["v"]);
  for (const row of JSON.parse(JSON.stringify(rows)))
    target.prepare("INSERT INTO cells VALUES (?)").run(decodeSqliteCell(row[0]));
  const output = target.prepare(
    "SELECT v, typeof(v) AS type, hex(CAST(v AS BLOB)) AS raw FROM cells",
  );
  output.setReadBigInts(true);
  const actual = output.all();
  assert.deepEqual(
    actual.map(({ type, raw }) => ({ type, raw })),
    before.map(({ type, raw }) => ({ type, raw })),
  );
  assert.equal(actual[0].v, values[0]);
  assert.equal(actual[1].v, values[1]);
  assert.equal(actual[2].v, Infinity);
  assert.equal(actual[4].v, values[4]);
  assert.deepEqual(Buffer.from(actual[5].v), values[5]);
  assert.equal(actual[6].v, null);
  assert.equal(target.prepare("SELECT v FROM retained").get().v, "target-owned");
  assert.deepEqual(
    source.prepare("SELECT typeof(v) AS type, hex(CAST(v AS BLOB)) AS raw FROM cells").all(),
    before,
  );
  assert(Object.is(decodeSqliteCell(encodeSqliteCell("real", -0)), -0));
});

test("malformed SQLite TEXT is preserved at source and rejected before any destination mutation", (t) => {
  const source = new DatabaseSync(":memory:"),
    target = new DatabaseSync(":memory:");
  t.after(() => {
    source.close();
    target.close();
  });
  source.exec("CREATE TABLE cells (v); INSERT INTO cells VALUES(CAST(x'80ff' AS TEXT));");
  target.exec("CREATE TABLE cells (v); INSERT INTO cells VALUES('preserve');");
  assert.throws(() => readTypedSqliteRows(source, "cells", ["v"]), {
    code: "NATIVE_SQLITE_TEXT_NOT_ROUNDTRIPPABLE",
  });
  assert.equal(source.prepare("SELECT hex(CAST(v AS BLOB)) AS raw FROM cells").get().raw, "80FF");
  assert.equal(target.prepare("SELECT v FROM cells").get().v, "preserve");
  for (const cell of [
    { type: "integer", value: "9223372036854775808" },
    { type: "integer", value: "-0" },
    { type: "real", ieee754: "7ff8000000000000" },
    { type: "blob", base64: "A" },
    { type: "text", value: "other", utf8: "ZXhhY3Q=" },
  ])
    assert.throws(() => decodeSqliteCell(cell));
  assert.throws(
    () => readTypedSqliteRows(source, "cells", ["v"], { where: "WHERE 1=1; DROP TABLE cells" }),
    { code: "NATIVE_SQLITE_SELECTION_INVALID" },
  );
});

test("the exact native profile checks full DDL/migrations and preserves selected typed rows", (t) => {
  const { db, row } = syntheticNativeHistory(t),
    threadId = "01900000-0000-7000-8000-000000000001";
  row("thread_turns", {
    thread_id: threadId,
    turn_id: "turn-a",
    status: "completed",
    rollout_byte_offset: 9223372036854775807n,
  });
  row("thread_items", {
    thread_id: threadId,
    turn_id: "turn-a",
    item_id: "item-a",
    item_type: "userMessage",
    item_json: '{"opaque":"preserved"}',
  });
  row("thread_history_projection_state", {
    thread_id: threadId,
    next_rollout_byte_offset: 9223372036854775807n,
    next_rollout_ordinal: 3n,
  });
  const inspected = inspectCodexNativeDatabase(db, {
    ...profileBasis,
    file: "thread_history_1.sqlite",
  });
  assert.equal(inspected.nativeWriteAuthorized, false);
  const selected = readSelectedCodexHistory(db, { ...profileBasis, threadIds: [threadId] });
  assert.equal(selected.tables.find((table) => table.name === "thread_turns").rows.length, 1);
  assert.equal(selected.quiescence, "not-observed");
  assert.equal(selected.coherentRawCutoff, "not-verified");
  const encoded = JSON.stringify(selected);
  assert(encoded.includes("9223372036854775807"));
  db.exec(
    "CREATE TRIGGER unexpected_contract_change AFTER INSERT ON thread_items BEGIN SELECT 1; END;",
  );
  assert.throws(() => readSelectedCodexHistory(db, { ...profileBasis, threadIds: [threadId] }), {
    code: "NATIVE_CODEX_SCHEMA_UNSUPPORTED",
  });
});

test("native no-FK history rejects cross-thread turn matches and unknown engine/migration without effects", (t) => {
  const { db, row } = syntheticNativeHistory(t),
    a = "01900000-0000-7000-8000-000000000001",
    b = "01900000-0000-7000-8000-000000000002";
  row("thread_turns", { thread_id: a, turn_id: "same-turn", status: "completed" });
  row("thread_items", {
    thread_id: b,
    turn_id: "same-turn",
    item_id: "orphan-b",
    item_type: "userMessage",
    item_json: "{}",
  });
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.throws(() => readSelectedCodexHistory(db, { ...profileBasis, threadIds: [a, b] }), {
    code: "NATIVE_CODEX_HISTORY_TURN_UNRESOLVED",
  });
  assert.throws(
    () =>
      readSelectedCodexHistory(db, { ...profileBasis, engineVersion: "unknown", threadIds: [a] }),
    { code: "NATIVE_CODEX_PROFILE_UNSUPPORTED" },
  );
  db.exec(
    "UPDATE _sqlx_migrations SET checksum=x'00' WHERE version=(SELECT min(version) FROM _sqlx_migrations)",
  );
  assert.throws(() => readSelectedCodexHistory(db, { ...profileBasis, threadIds: [a] }), {
    code: "NATIVE_CODEX_MIGRATIONS_UNSUPPORTED",
  });
  assert.equal(db.prepare("SELECT count(*) AS n FROM thread_items").get().n, 1);
});

test("streamed native JSONL matches exact typed-row byte boundaries and preserves opaque fields", (t) => {
  const f = fixture(t),
    { db, row } = syntheticNativeHistory(t),
    threadId = "01900000-0000-7000-8000-000000000003";
  const records = [
    {
      ordinal: 0,
      type: "session_meta",
      payload: {
        session_id: threadId,
        id: threadId,
        cli_version: nativeProfile.engineVersion,
        history_mode: "paginated",
      },
    },
    {
      ordinal: 1,
      type: "response_item",
      payload: { opaque: "한글 합성 자료", futureField: [null, { keep: "exact" }] },
    },
    { ordinal: 2, type: "future_opaque_event", payload: { v: 42 } },
  ];
  const lines = records.map((value) => Buffer.from(JSON.stringify(value) + "\n")),
    raw = Buffer.concat(lines);
  const relative = "sessions/synthetic/selected.jsonl",
    file = path.join(f.base, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw);
  row("thread_turns", {
    thread_id: threadId,
    turn_id: "turn-a",
    status: "completed",
    rollout_ordinal: 1n,
    rollout_byte_offset: BigInt(lines[0].length),
    rollout_end_ordinal: 2n,
    rollout_end_byte_offset: BigInt(raw.length),
  });
  row("thread_items", {
    thread_id: threadId,
    turn_id: "turn-a",
    item_id: "item-a",
    rollout_ordinal: 1n,
    updated_at_ordinal: 2n,
    item_type: "userMessage",
    item_json: "{}",
  });
  row("thread_history_projection_state", {
    thread_id: threadId,
    next_rollout_byte_offset: BigInt(raw.length),
    next_rollout_ordinal: 3n,
  });
  const history = readSelectedCodexHistory(db, { ...profileBasis, threadIds: [threadId] });
  const stream = createCodexRolloutVerifier({ threadId, history });
  for (let offset = 0; offset < raw.length; offset += 2)
    stream.update(raw.subarray(offset, offset + 2));
  assert.equal(stream.finish().formatAndAddressReady, true);
  assert.throws(() => stream.finish(), { code: "NATIVE_CODEX_ROLLOUT_STREAM_INVALID" });
  const verified = verifyCodexRollout({ root: f.base, relative, threadId, history });
  assert.equal(verified.raw.sha256, crypto.createHash("sha256").update(raw).digest("hex"));
  assert.equal(verified.quiescence, "not-observed");
  assert.equal(verified.nativePublicationReady, false);
  assert.equal(verified.nativeWriteAuthorized, false);
  assert.deepEqual(fs.readFileSync(file), raw);
  const before = snapshot(f.base);
  const wrong = structuredClone(history),
    projection = wrong.tables.find((table) => table.name === "thread_history_projection_state");
  projection.rows[0][projection.columns.indexOf("next_rollout_byte_offset")] = encodeSqliteCell(
    "integer",
    BigInt(raw.length - 1),
  );
  assert.throws(() => verifyCodexRollout({ root: f.base, relative, threadId, history: wrong }), {
    code: "NATIVE_CODEX_CUTOFF_MISMATCH",
  });
  assert.deepEqual(snapshot(f.base), before);
  fs.writeFileSync(file, raw.subarray(0, -1));
  assert.throws(() => verifyCodexRollout({ root: f.base, relative, threadId, history }), {
    code: "NATIVE_CODEX_ROLLOUT_INCOMPLETE",
  });
  fs.writeFileSync(file, raw);
  const forged = Buffer.from(raw);
  forged[forged.indexOf(Buffer.from('"ordinal":1')) + 10] = 57;
  fs.writeFileSync(file, forged);
  assert.throws(() => verifyCodexRollout({ root: f.base, relative, threadId, history }), {
    code: "NATIVE_CODEX_ROLLOUT_FRAME_INVALID",
  });
  fs.writeFileSync(file, raw);
  assert.throws(
    () => verifyCodexRollout({ root: f.base, relative: relative + ".zst", threadId, history }),
    { code: "NATIVE_CODEX_ROLLOUT_PROFILE_UNSUPPORTED" },
  );
  // A fork hint is retained verbatim and exposes unresolved native closure.
  records[2].payload.history_base_path = "other-original-required";
  const extended = Buffer.from(records.map((value) => JSON.stringify(value)).join("\n") + "\n");
  fs.writeFileSync(file, extended);
  db.prepare("UPDATE thread_turns SET rollout_end_byte_offset=?").run(BigInt(extended.length));
  db.prepare("UPDATE thread_history_projection_state SET next_rollout_byte_offset=?").run(
    BigInt(extended.length),
  );
  const partial = verifyCodexRollout({
    root: f.base,
    relative,
    threadId,
    history: readSelectedCodexHistory(db, { ...profileBasis, threadIds: [threadId] }),
  });
  assert.equal(partial.formatAndAddressReady, false);
  assert.deepEqual(partial.unresolvedClosure, ["history_base_path"]);
  assert.deepEqual(fs.readFileSync(file), extended);
});

test("native offline witness is current Host observation, never a saved marker or permission", async (t) => {
  const f = fixture(t),
    home = path.join(f.base, "native-home"),
    executable = path.join(f.base, "codex.exe");
  fs.mkdirSync(home);
  fs.writeFileSync(executable, "Synthetic never-executed native profile");
  fs.writeFileSync(path.join(home, "writers-stopped.json"), JSON.stringify({ stopped: true }));
  const before = snapshot(f.base);
  const unknown = await prepareCodexNativeOffline({
    home,
    executable,
    probe: async () => ({ status: "unknown", rows: [] }),
  });
  assert.equal(unknown.witness, null);
  assert.equal(unknown.ordinaryCoreBlocked, false);
  const active = await prepareCodexNativeOffline({
    home,
    executable,
    probe: async () => ({
      status: "observed",
      rows: [{ pid: 1234, birth: "synthetic-known-birth" }],
    }),
  });
  assert.equal(active.witness, null);
  let current = { status: "observed", rows: [] };
  const stopped = await prepareCodexNativeOffline({
    home,
    executable,
    probe: async () => current,
    versionProbe: async () => ({ status: "verified", version: nativeProfile.engineVersion }),
  });
  assert.equal(stopped.offlineWindowObserved, true);
  assert.equal(stopped.nativePublicationReady, false);
  assert.equal((await assertCodexNativeOffline(stopped.witness)).nativeWriteAuthorized, false);
  await assert.rejects(assertCodexNativeOffline(JSON.parse(JSON.stringify(stopped.witness))), {
    code: "NATIVE_CODEX_OFFLINE_WITNESS_REQUIRED",
  });
  current = { status: "observed", rows: [{ pid: 1234, birth: "later-synthetic-process-birth" }] };
  await assert.rejects(assertCodexNativeOffline(stopped.witness), {
    code: "NATIVE_CODEX_WRITER_STATE_UNCERTAIN",
  });
  current = { status: "observed", rows: [] };
  fs.appendFileSync(executable, " changed");
  await assert.rejects(assertCodexNativeOffline(stopped.witness), {
    code: "NATIVE_CODEX_OFFLINE_BASIS_CHANGED",
  });
  assert.deepEqual(
    fs.readFileSync(path.join(home, "writers-stopped.json")),
    Buffer.from(JSON.stringify({ stopped: true })),
  );
  assert.equal(inspectProject(f.root).status, "ready");
  assert.deepEqual(codexNativeOfflineProcessStatus(), []);
});

test("actual native writer inventory is query-only and reaps its hidden helper", async () => {
  const events = [],
    result = await observeCodexNativeWriters({ onProcess: (event) => events.push(event) });
  if (process.platform === "win32") {
    assert.equal(result.status, "observed");
    assert(Array.isArray(result.rows));
    assert(result.rows.every((row) => row.home === "unresolved"));
    assert.equal(events.filter((event) => event.event === "started").length, 1);
    assert.equal(events.filter((event) => event.event === "closed").length, 1);
    assert(events.every((event) => event.windowsHide === true));
  }
  assert.deepEqual(codexNativeOfflineProcessStatus(), []);
});

test("stopped native capture reads committed WAL and copies only selected raw/rows; generation drift never completes", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64")
    return t.skip(
      "Exact offline native capture profile is Windows x64 only; portable/pure verifiers remain tested.",
    );
  const f = fixture(t),
    home = path.join(f.base, "capture-home"),
    executable = path.join(f.base, "codex.exe");
  fs.mkdirSync(home);
  fs.writeFileSync(executable, "Synthetic never-executed engine");
  const a = "01900000-0000-7000-8000-000000000004",
    b = "01900000-0000-7000-8000-000000000005";
  const state = syntheticNativeDatabase(t, "state_5.sqlite", path.join(home, "state_5.sqlite"));
  const history = syntheticNativeDatabase(
    t,
    "thread_history_1.sqlite",
    path.join(home, "thread_history_1.sqlite"),
  );
  try {
    const relative = "sessions/2026/11/02/rollout-2026-11-02T00-00-00-" + a + ".jsonl",
      rawFile = path.join(home, relative);
    const raw = Buffer.from(
      [
        JSON.stringify({
          ordinal: 0,
          type: "session_meta",
          payload: {
            id: a,
            session_id: a,
            cli_version: nativeProfile.engineVersion,
            history_mode: "paginated",
          },
        }),
        JSON.stringify({
          ordinal: 1,
          type: "response_item",
          payload: { synthetic: "Selected exact original" },
        }),
      ].join("\n") + "\n",
    );
    fs.mkdirSync(path.dirname(rawFile), { recursive: true });
    fs.writeFileSync(rawFile, raw);
    state.row("threads", {
      id: a,
      rollout_path: rawFile,
      cli_version: nativeProfile.engineVersion,
      history_mode: "paginated",
    });
    state.row("threads", {
      id: b,
      rollout_path: path.join(home, "not-read"),
      creator_account_id: "UNSELECTED_ACCOUNT_SENTINEL",
    });
    history.db.exec("PRAGMA journal_mode=WAL");
    history.row("thread_turns", {
      thread_id: a,
      turn_id: "capture-turn",
      status: "completed",
      rollout_ordinal: 1n,
      rollout_byte_offset: BigInt(raw.indexOf(10) + 1),
      rollout_end_ordinal: 1n,
      rollout_end_byte_offset: BigInt(raw.length),
    });
    history.row("thread_items", {
      thread_id: a,
      turn_id: "capture-turn",
      item_id: "capture-item",
      rollout_ordinal: 1n,
      updated_at_ordinal: 1n,
      item_type: "userMessage",
      item_json: '{"text":"Selected exact original"}',
    });
    history.row("thread_history_projection_state", {
      thread_id: a,
      next_rollout_byte_offset: BigInt(raw.length),
      next_rollout_ordinal: 2n,
    });
    history.row("thread_turns", { thread_id: b, turn_id: "unselected", status: "completed" });
    const mainCopy = path.join(f.base, "main-only.sqlite");
    fs.copyFileSync(path.join(home, "thread_history_1.sqlite"), mainCopy);
    const main = new DatabaseSync(mainCopy, { readOnly: true });
    assert.equal(main.prepare("SELECT count(*) AS n FROM thread_turns").get().n, 0);
    main.close();
    let observeHook = null;
    const offline = await prepareCodexNativeOffline({
      home,
      executable,
      probe: async () => {
        observeHook?.();
        return { status: "observed", rows: [] };
      },
      versionProbe: async () => ({ status: "verified", version: nativeProfile.engineVersion }),
    });
    const destination = path.join(f.base, "native-capture");
    const captured = await captureCodexNativeHistory({
      witness: offline.witness,
      threadIds: [a],
      destination,
    });
    assert.equal(captured.status, "captured-native-originals");
    assert.equal(captured.nativePublicationReady, false);
    assert.equal(captured.nativeRegistration, "not-performed");
    const payloadBytes = fs.readFileSync(path.join(destination, "manifest.json")),
      payload = JSON.parse(payloadBytes);
    const inspectedPayload = inspectCodexNativePayload({
      directory: destination,
      expectedPayloadId: captured.payloadId,
    });
    assert.equal(inspectedPayload.mechanicalOriginalsReady, true);
    assert.equal(inspectedPayload.nativePublicationReady, false);
    assert(!Object.hasOwn(codexNativePayloadSummary(inspectedPayload), "payload"));
    assert.throws(
      () =>
        inspectCodexNativePayload({
          directory: destination,
          expectedPayloadId: "native-history-" + "0".repeat(24),
        }),
      { code: "NATIVE_CODEX_PAYLOAD_IDENTITY_MISMATCH" },
    );
    assert.equal(
      payload.history.tables.find((table) => table.name === "thread_turns").rows.length,
      1,
    );

    assert(!payloadBytes.toString().includes(b));
    assert(!payloadBytes.toString().includes("UNSELECTED_ACCOUNT_SENTINEL"));
    assert(!Object.hasOwn(payload, "sourceStateRows"));
    assert.deepEqual(
      fs.readFileSync(path.join(destination, "objects", payload.files[0].sha256 + ".bin")),
      raw,
    );
    assert.deepEqual(fs.readFileSync(rawFile), raw);
    const repeat = await captureCodexNativeHistory({
      witness: offline.witness,
      threadIds: [a],
      destination,
    });
    assert.equal(repeat.payloadId, captured.payloadId);
    async function nativeTarget(name) {
      const targetHome = path.join(f.base, name);
      fs.mkdirSync(targetHome, { recursive: true });
      const targetState = syntheticNativeDatabase(
        t,
        "state_5.sqlite",
        path.join(targetHome, "state_5.sqlite"),
      );
      const targetHistory = syntheticNativeDatabase(
        t,
        "thread_history_1.sqlite",
        path.join(targetHome, "thread_history_1.sqlite"),
      );
      try {
        targetHistory.row("thread_turns", {
          thread_id: b,
          turn_id: "target-owned-original",
          status: "completed",
          duration_ms: 9223372036854775807n,
        });
        targetHistory.db
          .prepare("UPDATE thread_turns SET error_json=CAST(x'80ff' AS TEXT) WHERE thread_id=?")
          .run(b);
      } finally {
        targetState.close();
        targetHistory.close();
      }
      let observation = { status: "observed", rows: [] };
      const targetOffline = await prepareCodexNativeOffline({
        home: targetHome,
        executable,
        probe: async () => observation,
        versionProbe: async () => ({ status: "verified", version: nativeProfile.engineVersion }),
      });
      return {
        targetHome,
        targetOffline,
        setObservation: (value) => {
          observation = value;
        },
      };
    }
    for (const stop of [null, "raw", "before-history-commit", "history-committed"]) {
      const { targetHome, targetOffline } = await nativeTarget(
        "native-target-" + (stop || "success"),
      );
      const stateBefore = fs.readFileSync(path.join(targetHome, "state_5.sqlite"));
      let interrupted = false;
      if (stop)
        await assert.rejects(
          publishCodexNativeHistory({
            witness: targetOffline.witness,
            directory: destination,
            onBoundary(stage) {
              if (stage === stop && !interrupted) {
                interrupted = true;
                throw Object.assign(Error("Synthetic stopped native publication"), {
                  code: "SYNTHETIC_STOP",
                });
              }
            },
          }),
          { code: "SYNTHETIC_STOP" },
        );
      const result = await publishCodexNativeHistory({
        witness: targetOffline.witness,
        directory: destination,
      });
      assert(
        ["native-originals-published", "native-originals-already-present"].includes(result.status),
      );
      assert.equal(result.nativeRegistration, "not-performed");
      assert.equal(result.stateRowsWritten, 0);
      assert.deepEqual(fs.readFileSync(path.join(targetHome, relative)), raw);
      assert.deepEqual(fs.readFileSync(path.join(targetHome, "state_5.sqlite")), stateBefore);
      const actualDb = new DatabaseSync(path.join(targetHome, "thread_history_1.sqlite"), {
        readOnly: true,
      });
      try {
        assert.deepEqual(
          readSelectedCodexHistory(actualDb, { ...profileBasis, threadIds: [a] }),
          payload.history,
        );
        const retained = actualDb.prepare("SELECT duration_ms FROM thread_turns WHERE thread_id=?");
        retained.setReadBigInts(true);
        assert.equal(retained.get(b).duration_ms, 9223372036854775807n);
        assert.equal(
          actualDb
            .prepare(
              "SELECT hex(CAST(error_json AS BLOB)) AS raw FROM thread_turns WHERE thread_id=?",
            )
            .get(b).raw,
          "80FF",
        );
      } finally {
        actualDb.close();
      }
      const beforeRetry = snapshot(targetHome),
        again = await publishCodexNativeHistory({
          witness: targetOffline.witness,
          directory: destination,
        });
      assert.equal(again.status, "native-originals-already-present");
      assert.deepEqual(snapshot(targetHome), beforeRetry);
    }
    for (const kind of [
      "raw-diverged",
      "history-diverged",
      "authority-denied",
      "disk-full",
      "writer-restarted",
    ]) {
      const { targetHome, targetOffline, setObservation } = await nativeTarget(
        "native-negative-" + kind,
      );
      const targetRaw = path.join(targetHome, relative),
        targetDbPath = path.join(targetHome, "thread_history_1.sqlite"),
        beforeState = fs.readFileSync(path.join(targetHome, "state_5.sqlite"));
      if (kind === "raw-diverged") {
        fs.mkdirSync(path.dirname(targetRaw), { recursive: true });
        fs.writeFileSync(targetRaw, "Newer target raw remains");
      }
      if (kind === "history-diverged") {
        const db = new DatabaseSync(targetDbPath);
        try {
          const table = payload.history.tables.find((item) => item.name === "thread_turns"),
            values = table.rows[0].map(decodeSqliteCell);
          values[table.columns.indexOf("duration_ms")] = 123456n;
          db.prepare(
            "INSERT INTO thread_turns (" +
              table.columns.map((name) => '"' + name + '"').join(",") +
              ") VALUES (" +
              values.map(() => "?").join(",") +
              ")",
          ).run(...values);
        } finally {
          db.close();
        }
      }
      const before = snapshot(targetHome),
        link = fs.linkSync;
      if (kind === "disk-full")
        fs.linkSync = function (source, target) {
          if (String(source).endsWith(".partial.sqlite"))
            throw Object.assign(Error("Synthetic backup disk full"), { code: "ENOSPC" });
          return link.call(this, source, target);
        };
      const expected = {
        "raw-diverged": "PROJECT_COPY_SOURCE_CHANGED",
        "history-diverged": "NATIVE_CODEX_TARGET_HISTORY_DIVERGED",
        "authority-denied": "SYNTHETIC_AUTHORITY_DENIED",
        "disk-full": "ENOSPC",
        "writer-restarted": "NATIVE_CODEX_WRITER_STATE_UNCERTAIN",
      }[kind];
      try {
        await assert.rejects(
          publishCodexNativeHistory({
            witness: targetOffline.witness,
            directory: destination,
            assertCurrentAuthority() {
              if (kind === "authority-denied")
                throw Object.assign(Error("Synthetic current decision denial"), {
                  code: "SYNTHETIC_AUTHORITY_DENIED",
                });
            },
            onBoundary(stage) {
              if (kind === "writer-restarted" && stage === "raw")
                setObservation({
                  status: "observed",
                  rows: [{ pid: 9876, birth: "synthetic-restarted-engine" }],
                });
            },
          }),
          { code: expected },
        );
      } finally {
        fs.linkSync = link;
      }
      assert.deepEqual(fs.readFileSync(path.join(targetHome, "state_5.sqlite")), beforeState);
      if (["raw-diverged", "history-diverged", "authority-denied"].includes(kind))
        assert.deepEqual(snapshot(targetHome), before);
      else {
        const db = new DatabaseSync(targetDbPath, { readOnly: true });
        try {
          assert.equal(
            db.prepare("SELECT count(*) AS n FROM thread_turns WHERE thread_id=?").get(a).n,
            0,
          );
        } finally {
          db.close();
        }
        if (kind === "disk-full") assert(!fs.existsSync(targetRaw));
        setObservation({ status: "observed", rows: [] });
        assert.equal(
          (
            await publishCodexNativeHistory({
              witness: targetOffline.witness,
              directory: destination,
            })
          ).status,
          "native-originals-published",
        );
      }
    }
    {
      const { targetHome, targetOffline } = await nativeTarget("native-cancel-at-intent"),
        controller = new AbortController();
      await assert.rejects(
        publishCodexNativeHistory({
          witness: targetOffline.witness,
          directory: destination,
          signal: controller.signal,
          onBoundary(stage) {
            if (stage === "intent") controller.abort();
          },
        }),
        { code: "NATIVE_CODEX_PUBLICATION_CANCELLED" },
      );
      const operations = path.join(targetHome, ".lode-native-portability"),
        operation = path.join(operations, fs.readdirSync(operations)[0]);
      assert(!fs.existsSync(path.join(operation, "backups")));
      assert(!fs.existsSync(path.join(operation, "backup.json")));
      assert(!fs.existsSync(path.join(targetHome, relative)));
    }
    {
      const { targetHome, targetOffline } = await nativeTarget("native-backup-corrupt");
      await assert.rejects(
        publishCodexNativeHistory({
          witness: targetOffline.witness,
          directory: destination,
          onBoundary(stage) {
            if (stage === "raw")
              throw Object.assign(Error("Synthetic partial publication"), {
                code: "SYNTHETIC_STOP",
              });
          },
        }),
        { code: "SYNTHETIC_STOP" },
      );
      const operations = path.join(targetHome, ".lode-native-portability"),
        operation = path.join(operations, fs.readdirSync(operations)[0]),
        receiptFile = path.join(operation, "backup.json");
      const receiptBytes = fs.readFileSync(receiptFile),
        receipt = JSON.parse(receiptBytes),
        saved = fs.readFileSync(path.join(targetHome, receipt.path));
      const invalid = Buffer.from("This is not SQLite backup data"),
        invalidSha = crypto.createHash("sha256").update(invalid).digest("hex");
      const invalidPath = path.posix.dirname(receipt.path) + "/" + invalidSha + ".sqlite";
      fs.writeFileSync(path.join(targetHome, invalidPath), invalid);
      fs.writeFileSync(
        receiptFile,
        JSON.stringify({
          ...receipt,
          path: invalidPath,
          bytes: invalid.length,
          sha256: invalidSha,
        }),
      );
      const before = snapshot(targetHome);
      await assert.rejects(
        publishCodexNativeHistory({ witness: targetOffline.witness, directory: destination }),
        (error) => error.code === "ERR_SQLITE_ERROR" && error.nativeStage === "backup-validation",
      );
      assert.deepEqual(snapshot(targetHome), before);
      fs.writeFileSync(path.join(targetHome, receipt.path), saved);
      fs.writeFileSync(receiptFile, receiptBytes);
      assert.equal(
        (
          await publishCodexNativeHistory({
            witness: targetOffline.witness,
            directory: destination,
          })
        ).status,
        "native-originals-published",
      );
    }
    {
      const { targetHome, targetOffline } = await nativeTarget(
        path.join("long-native-" + "a".repeat(75), "b".repeat(75)),
      );
      const result = await publishCodexNativeHistory({
        witness: targetOffline.witness,
        directory: destination,
      });
      assert.equal(result.status, "native-originals-published");
      const operations = path.join(targetHome, ".lode-native-portability"),
        operation = path.join(operations, fs.readdirSync(operations)[0]),
        receipt = JSON.parse(fs.readFileSync(path.join(operation, "backup.json")));
      assert(path.join(targetHome, receipt.path).length > 260);
      assert.deepEqual(fs.readFileSync(path.join(targetHome, relative)), raw);
    }
    const drift = path.join(f.base, "native-capture-drift");
    await assert.rejects(
      captureCodexNativeHistory({
        witness: offline.witness,
        threadIds: [a],
        destination: drift,
        onBoundary(stage) {
          if (stage === "captured")
            history.db.prepare("UPDATE thread_turns SET duration_ms=123 WHERE thread_id=?").run(a);
        },
      }),
      { code: "NATIVE_CODEX_CAPTURE_GENERATION_CHANGED" },
    );
    assert(!fs.existsSync(path.join(drift, "manifest.json")));
    assert(fs.existsSync(path.join(drift, "capture-intent.json")));
    let checks = 0;
    observeHook = () => {
      if (++checks === 3)
        history.db.prepare("UPDATE thread_turns SET duration_ms=888 WHERE thread_id=?").run(a);
    };
    const lastAwait = path.join(f.base, "native-capture-last-observer");
    await assert.rejects(
      captureCodexNativeHistory({
        witness: offline.witness,
        threadIds: [a],
        destination: lastAwait,
      }),
      { code: "NATIVE_CODEX_CAPTURE_GENERATION_CHANGED" },
    );
    assert.equal(checks, 3);
    assert(!fs.existsSync(path.join(lastAwait, "manifest.json")));
    observeHook = null;
    for (const method of ["prepare", "exec"]) {
      const original = DatabaseSync.prototype[method];
      let observedHandle = null;
      DatabaseSync.prototype[method] = function (query, ...args) {
        if (
          observedHandle === null &&
          query === (method === "prepare" ? "PRAGMA data_version" : "BEGIN")
        ) {
          observedHandle = this;
          throw Object.assign(Error("Synthetic SQLite busy immediately after open"), {
            code: "SQLITE_BUSY",
          });
        }
        return original.call(this, query, ...args);
      };
      const failedOpen = path.join(f.base, "native-capture-open-" + method);
      try {
        await assert.rejects(
          captureCodexNativeHistory({
            witness: offline.witness,
            threadIds: [a],
            destination: failedOpen,
          }),
          { code: "SQLITE_BUSY" },
        );
      } finally {
        DatabaseSync.prototype[method] = original;
      }
      assert(observedHandle);
      assert.throws(() => observedHandle.prepare("SELECT 1"), { code: "ERR_INVALID_STATE" });
      assert(!fs.existsSync(failedOpen));
    }
    assert.equal(inspectProject(f.root).status, "ready");
    assert.deepEqual(codexNativeOfflineProcessStatus(), []);
  } finally {
    history.close();
    state.close();
  }
});

test("native row merge preserves unrelated data and never replaces divergent selected rows", (t) => {
  const source = syntheticNativeHistory(t),
    target = syntheticNativeHistory(t),
    a = "01900000-0000-7000-8000-000000000006",
    b = "01900000-0000-7000-8000-000000000007";
  source.row("thread_turns", { thread_id: a, turn_id: "selected-turn", status: "completed" });
  source.row("thread_items", {
    thread_id: a,
    turn_id: "selected-turn",
    item_id: "selected-item",
    item_type: "userMessage",
    item_json: '{"text":"Selected original"}',
  });
  source.row("thread_history_projection_state", {
    thread_id: a,
    next_rollout_byte_offset: 10n,
    next_rollout_ordinal: 2n,
  });
  target.row("thread_turns", {
    thread_id: b,
    turn_id: "unrelated-turn",
    status: "completed",
    duration_ms: 9223372036854775807n,
  });
  const unrelated = readSelectedCodexHistory(target.db, { ...profileBasis, threadIds: [b] });
  const history = readSelectedCodexHistory(source.db, { ...profileBasis, threadIds: [a] });
  const preview = planCodexNativeRowMerge(target.db, { ...profileBasis, history });
  assert.equal(preview.status, "absent");
  assert.equal(preview.missingRows, 3);
  assert.throws(() => applyCodexNativeRowMerge(preview.plan, target.db), {
    code: "NATIVE_CODEX_HISTORY_TRANSACTION_REQUIRED",
  });
  assert.throws(
    () => applyCodexNativeRowMerge(JSON.parse(JSON.stringify(preview.plan)), target.db),
    { code: "NATIVE_CODEX_ROW_PLAN_REQUIRED" },
  );
  target.db.exec("BEGIN IMMEDIATE");
  const applied = applyCodexNativeRowMerge(preview.plan, target.db);
  assert.equal(applied.transactionCommitted, false);
  target.db.exec("COMMIT");
  assert.equal(applied.stateRowsWritten, 0);
  assert.deepEqual(
    readSelectedCodexHistory(target.db, { ...profileBasis, threadIds: [a] }),
    history,
  );
  assert.deepEqual(
    readSelectedCodexHistory(target.db, { ...profileBasis, threadIds: [b] }),
    unrelated,
  );
  const repeat = planCodexNativeRowMerge(target.db, { ...profileBasis, history });
  assert.equal(repeat.status, "equal");
  assert.equal(repeat.missingRows, 0);
  target.db
    .prepare("UPDATE thread_items SET item_json=? WHERE thread_id=?")
    .run('{"text":"Newer target content"}', a);
  assert.throws(() => planCodexNativeRowMerge(target.db, { ...profileBasis, history }), {
    code: "NATIVE_CODEX_TARGET_HISTORY_DIVERGED",
  });
  assert.equal(
    target.db.prepare("SELECT item_json FROM thread_items WHERE thread_id=?").get(a).item_json,
    '{"text":"Newer target content"}',
  );
  assert.deepEqual(
    readSelectedCodexHistory(target.db, { ...profileBasis, threadIds: [b] }),
    unrelated,
  );
});

test("native registration reconciles observed completion and never replays uncertain or competing attempts", async (t) => {
  const f = fixture(t),
    input = {
      provider: "codex",
      profileId: nativeProfile.profileId,
      payloadDigest: "1".repeat(64),
      targetHomeDigest: "2".repeat(64),
      nativeThreadId: "01900000-0000-7000-8000-000000000008",
      targetPathDigest: "3".repeat(64),
      currentPolicyDigest: "4".repeat(64),
      runtimeRootsDigest: "5".repeat(64),
    };
  for (const mode of ["normal", "lost-after-effect", "lost-before-effect", "concurrent"]) {
    const operationRoot = path.join(f.base, "registration-" + mode);
    fs.mkdirSync(operationRoot);
    let state = "absent",
      calls = 0;
    const readStatus = async ({ inputDigest }) => ({
      inputDigest,
      state,
      evidenceDigest: "6".repeat(64),
    });
    const register = async () => {
      calls++;
      if (mode === "lost-before-effect")
        throw Object.assign(Error("Synthetic no durable response"), { code: "SYNTHETIC_LOSS" });
      state = "matches";
      if (mode === "lost-after-effect")
        throw Object.assign(Error("Synthetic response lost after effect"), {
          code: "SYNTHETIC_LOSS",
        });
    };
    const invoke = () => requestNativeRegistration({ operationRoot, input, readStatus, register });
    const first =
      mode === "concurrent" ? (await Promise.all([invoke(), invoke()]))[0] : await invoke();
    assert.equal(calls, 1);
    assert.equal(first.automaticReplayAllowed, false);
    if (mode.startsWith("lost")) assert.equal(first.status, "native-registration-uncertain");
    const again = await invoke();
    assert.equal(calls, 1);
    assert.equal(
      again.status,
      mode === "lost-before-effect"
        ? "native-registration-uncertain"
        : "native-registration-verified",
    );
    const before = snapshot(operationRoot);
    await invoke();
    assert.deepEqual(
      snapshot(operationRoot),
      before,
      "unchanged status reuses at most one attempt/result pair",
    );
    if (mode === "normal") {
      const resultFile = path.join(
          operationRoot,
          fs.readdirSync(operationRoot).find((name) => name.endsWith(".result.json")),
        ),
        originalResult = fs.readFileSync(resultFile),
        record = JSON.parse(originalResult);
      fs.writeFileSync(resultFile, JSON.stringify({ ...record, evidenceDigest: "0".repeat(64) }));
      await assert.rejects(invoke(), { code: "NATIVE_REGISTRATION_JOURNAL_INVALID" });
      assert.equal(calls, 1);
      fs.writeFileSync(resultFile, originalResult);
      const attemptFile = path.join(
          operationRoot,
          fs.readdirSync(operationRoot).find((name) => name.endsWith(".attempt.json")),
        ),
        originalAttempt = fs.readFileSync(attemptFile);
      fs.unlinkSync(attemptFile);
      await assert.rejects(invoke(), { code: "NATIVE_REGISTRATION_JOURNAL_INVALID" });
      assert.equal(calls, 1);
      fs.writeFileSync(attemptFile, originalAttempt);
      await assert.rejects(
        requestNativeRegistration({
          operationRoot,
          input: { ...input, currentPolicyDigest: "9".repeat(64) },
          readStatus,
          register,
        }),
        { code: "NATIVE_REGISTRATION_JOURNAL_INVALID" },
      );
      assert.equal(calls, 1);
    }
  }
  const operationRoot = path.join(f.base, "registration-refused");
  fs.mkdirSync(operationRoot);
  let calls = 0;
  const invoke = () =>
    requestNativeRegistration({
      operationRoot,
      input,
      readStatus: async ({ inputDigest }) => ({ inputDigest, state: "absent" }),
      register: async () => {
        calls++;
      },
      assertCurrentAuthority() {
        throw Object.assign(Error("Synthetic current permission denial"), {
          code: "SYNTHETIC_DENIED",
        });
      },
    });
  await assert.rejects(invoke(), { code: "SYNTHETIC_DENIED" });
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(operationRoot), []);
});

test("native companion binds selected transfer data without becoming a Core import gate", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64")
    return t.skip("Measured native filesystem profile is Windows x64.");
  const { f, destination, payload } = await syntheticNativeCapture(t);

  f.save({ summary: "Selected synthetic portable context" });
  const bundleRoot = path.join(f.base, "common-with-native");
  const common = f.route(() => exportProjectBundle({ root: f.root, destination: bundleRoot }));
  const commonManifest = fs.readFileSync(path.join(bundleRoot, "manifest.json"));
  assert.equal(readProjectNativeTransfer({ bundleRoot }).status, "native-history-not-attached");
  const abort = new AbortController();
  assert.throws(
    () =>
      attachProjectNativeTransfer({
        bundleRoot,
        directory: destination,
        signal: abort.signal,
        onObject() {
          abort.abort();
        },
      }),
    { code: "PROJECT_NATIVE_TRANSFER_CANCELLED" },
  );
  assert.equal(
    readProjectNativeTransfer({ bundleRoot }).status,
    "native-transfer-incomplete-without-link",
  );
  const attached = attachProjectNativeTransfer({ bundleRoot, directory: destination });
  assert.equal(attached.status, "verified-native-transfer");
  assert.equal(attached.transfersNativeBinding, false);
  assert.equal(attached.logicalSessionOwnership, "not-established-by-this-link");
  assert(fs.readFileSync(path.join(bundleRoot, "manifest.json")).equals(commonManifest));
  const before = snapshot(bundleRoot);
  attachProjectNativeTransfer({ bundleRoot, directory: destination });
  assert.deepEqual(snapshot(bundleRoot), before);
  const cli = await runCommand(["project-native-history", bundleRoot, "--action", "read"]);
  const response = await dispatch({
    jsonrpc: "2.0",
    id: "native-read",
    method: "tools/call",
    params: {
      name: "lode_project_native_history",
      arguments: { action: "read", bundle_root: bundleRoot },
    },
  });
  assert(!response.error, JSON.stringify(response));
  const mcp = response.result.structuredContent;
  assert.equal(cli.native.payloadId, mcp.native.payloadId);
  assert.equal(cli.bundleId, common.bundleId);
  assert(!JSON.stringify(cli).includes("Selected exact original"));
  const currentTransfer = readProjectNativeTransfer({ bundleRoot });
  assertProjectNativeTransferCurrent({
    bundleRoot,
    commonManifestDigest: currentTransfer.commonManifestDigest,
    linkDigest: currentTransfer.linkDigest,
  });
  const nestedHome = path.join(bundleRoot, "unpublishable-native-home");
  fs.mkdirSync(nestedHome);
  let observedProcesses = 0;
  await assert.rejects(
    operateProjectNativeHistory({
      action: "restore",
      bundleRoot,
      nativeHome: nestedHome,
      executable: path.join(f.base, "codex.exe"),
      onProcess() {
        observedProcesses++;
      },
    }),
    { code: "PROJECT_NATIVE_SOURCE_TARGET_OVERLAP" },
  );
  assert.equal(observedProcesses, 0);
  const linkFile = path.join(bundleRoot, "native-history.json"),
    originalLink = fs.readFileSync(linkFile),
    link = JSON.parse(originalLink);
  fs.writeFileSync(linkFile, JSON.stringify({ ...link, selectedSessionId: "session-foreign" }));
  assert.throws(() => readProjectNativeTransfer({ bundleRoot }), {
    code: "PROJECT_NATIVE_TRANSFER_LINK_MISMATCH",
  });
  assert.throws(
    () =>
      assertProjectNativeTransferCurrent({
        bundleRoot,
        commonManifestDigest: currentTransfer.commonManifestDigest,
        linkDigest: currentTransfer.linkDigest,
      }),
    { code: "PROJECT_NATIVE_TRANSFER_IDENTITY_CHANGED" },
  );
  const readBoth = await dispatch({
    jsonrpc: "2.0",
    id: "native-invalid-read",
    method: "tools/call",
    params: {
      name: "lode_project_bundle_read",
      arguments: { bundle_root: bundleRoot, include_native_history: true },
    },
  });
  assert(!readBoth.error, JSON.stringify(readBoth));
  assert.equal(readBoth.result.structuredContent.nativeHistory.isError, true);
  assert.equal(
    readBoth.result.structuredContent.nativeHistory.primaryFailure.code,
    "PROJECT_NATIVE_TRANSFER_LINK_MISMATCH",
  );
  assert.equal(inspectProjectBundle({ bundleRoot }).projectAdmissionReady, true);
  const target = path.join(f.base, "core-import-native-damaged");
  fs.mkdirSync(target);
  assert.equal(importProjectBundle({ bundleRoot, root: target, pluginRoot }).status, "imported");
  assert(
    !fs.existsSync(path.join(target, "native-history.json")),
    "native companion is never an execution binding in Core import",
  );
  fs.writeFileSync(linkFile, originalLink);
  const rawObject = path.join(
      bundleRoot,
      "native/codex/history/objects",
      payload.files[0].sha256 + ".bin",
    ),
    originalObject = fs.readFileSync(rawObject);
  fs.writeFileSync(rawObject, Buffer.from("Divergent target native bytes"));
  assert.throws(() => readProjectNativeTransfer({ bundleRoot }));
  assert.equal(inspectProjectBundle({ bundleRoot }).projectAdmissionReady, true);
  fs.writeFileSync(rawObject, originalObject);
});

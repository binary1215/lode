import fs from "node:fs";
import path from "node:path";
import { fixture } from "./session-work-linkage-fixture.mjs";
import { prepareCodexNativeOffline } from "../../scripts/lib/distribution/codex-native-offline.mjs";
import { captureCodexNativeHistory } from "../../scripts/lib/distribution/codex-native-capture.mjs";
import { DatabaseSync } from "node:sqlite";
import { nativeSqlitePath } from "../../scripts/lib/distribution/codex-native-backup.mjs";
import { codexNativePortabilityProfile } from "../../scripts/lib/distribution/codex-native-portability.mjs";
export const nativeProfile = codexNativePortabilityProfile();

export const profileBasis = {
  engineVersion: nativeProfile.engineVersion,
  platform: "win32",
  architecture: "x64",
};

export function syntheticNativeDatabase(t, profileFile, location = ":memory:") {
  const db = new DatabaseSync(location === ":memory:" ? location : nativeSqlitePath(location));
  let closed = false;
  const close = () => {
    if (!closed) {
      db.close();
      closed = true;
    }
  };
  t.after(close);
  const profile = nativeProfile.databases.find((item) => item.file === profileFile);
  // Trusted pinned test DDL only. Production never executes imported source DDL.
  for (const type of ["table", "index", "trigger"])
    for (const entry of profile.schema)
      if (entry.type === type && entry.sql && !entry.name.startsWith("sqlite_")) db.exec(entry.sql);
  if (profile.schema.some((entry) => entry.name === "sqlite_sequence"))
    db.exec(
      "CREATE TABLE __fixture_sequence(id INTEGER PRIMARY KEY AUTOINCREMENT);DROP TABLE __fixture_sequence;",
    );
  const insert = db.prepare(
    "INSERT INTO _sqlx_migrations(version,description,installed_on,success,checksum,execution_time) VALUES(?,?,?,?,?,?)",
  );
  for (const row of profile.migrations)
    insert.run(
      BigInt(row.version),
      row.description,
      "2026-01-01T00:00:00Z",
      BigInt(row.success),
      Buffer.from(row.checksum, "hex"),
      0n,
    );
  const row = (name, overrides) => {
    const columns = profile.tables.find((item) => item.name === name).columns;
    const values = columns.map((column) =>
      Object.hasOwn(overrides, column.name)
        ? overrides[column.name]
        : column.notnull || column.pk
          ? column.type.includes("INT")
            ? 0n
            : "synthetic"
          : null,
    );
    db.prepare(
      'INSERT INTO "' +
        name +
        '" (' +
        columns.map((column) => '"' + column.name + '"').join(",") +
        ") VALUES(" +
        columns.map(() => "?").join(",") +
        ")",
    ).run(...values);
  };
  return { db, row, close };
}

export function syntheticNativeHistory(t) {
  return syntheticNativeDatabase(t, "thread_history_1.sqlite");
}

export async function syntheticNativeCapture(t) {
  const f = fixture(t),
    home = path.join(f.base, "native-source"),
    executable = path.join(f.base, "codex.exe"),
    threadId = "01900000-0000-7000-8000-000000000004";
  fs.mkdirSync(home);
  fs.writeFileSync(executable, "Synthetic never-executed engine");
  const state = syntheticNativeDatabase(t, "state_5.sqlite", path.join(home, "state_5.sqlite")),
    history = syntheticNativeDatabase(
      t,
      "thread_history_1.sqlite",
      path.join(home, "thread_history_1.sqlite"),
    );
  try {
    const relative = "sessions/2026/11/02/rollout-synthetic-" + threadId + ".jsonl",
      rawFile = path.join(home, relative);
    const raw = Buffer.from(
      [
        JSON.stringify({
          ordinal: 0,
          type: "session_meta",
          payload: {
            id: threadId,
            session_id: threadId,
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
      id: threadId,
      rollout_path: rawFile,
      cli_version: nativeProfile.engineVersion,
      history_mode: "paginated",
    });
    history.row("thread_turns", {
      thread_id: threadId,
      turn_id: "turn",
      status: "completed",
      rollout_ordinal: 1n,
      rollout_byte_offset: BigInt(raw.indexOf(10) + 1),
      rollout_end_ordinal: 1n,
      rollout_end_byte_offset: BigInt(raw.length),
    });
    history.row("thread_items", {
      thread_id: threadId,
      turn_id: "turn",
      item_id: "item",
      rollout_ordinal: 1n,
      updated_at_ordinal: 1n,
      item_type: "userMessage",
      item_json: '{"type":"userMessage","id":"item","content":[]}',
    });
    history.row("thread_history_projection_state", {
      thread_id: threadId,
      next_rollout_byte_offset: BigInt(raw.length),
      next_rollout_ordinal: 2n,
    });
    const offline = await prepareCodexNativeOffline({
      home,
      executable,
      probe: async () => ({ status: "observed", rows: [] }),
      versionProbe: async () => ({ status: "verified", version: nativeProfile.engineVersion }),
    });
    const destination = path.join(f.base, "native-payload");
    const captured = await captureCodexNativeHistory({
      witness: offline.witness,
      threadIds: [threadId],
      destination,
    });
    return {
      f,
      home,
      executable,
      destination,
      captured,
      payload: JSON.parse(fs.readFileSync(path.join(destination, "manifest.json"))),
    };
  } finally {
    state.close();
    history.close();
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import {
  syntheticNativeCapture,
  syntheticNativeDatabase,
  nativeProfile,
} from "./helpers/native-portability-fixture.mjs";
import { prepareCodexNativeOffline } from "../scripts/lib/distribution/codex-native-offline.mjs";
import { captureCodexNativeHistory } from "../scripts/lib/distribution/codex-native-capture.mjs";
import { publishCodexNativeHistory } from "../scripts/lib/distribution/codex-native-publication.mjs";
import { nativeSqlitePath } from "../scripts/lib/distribution/codex-native-backup.mjs";
import { codexNativeApiExpectation } from "../scripts/lib/distribution/codex-native-api-evidence.mjs";

test("SDK preparation retries safely while delivery, selected targets and concurrent attempts stay bounded", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64")
    return t.skip("Measured native filesystem profile is Windows x64.");
  for (const scenario of [
    "unchanged",
    "external-edit",
    "backup-enospc",
    "state-replaced",
    "revoked-after-backup",
    "raw-changed-after-backup",
    "concurrent",
    "partial-resume",
    "partial-user-edit",
    "partial-existing",
    "snapshot-only",
    "snapshot-tamper",
    "missing-member-result",
    "snapshot-parent-tamper",
    "group-initial-tamper",
    "operation-root-junction",
  ])
    await t.test(scenario, async (t) => {
      const { f, home, executable, payload } = await syntheticNativeCapture(t),
        first = payload.threadIds[0],
        second = first.slice(0, -1) + "5",
        oldRaw = payload.files[0].path,
        newRaw = oldRaw.replace(first, second);
      // Fixture authoring only, never a production rewrite of imported history.
      fs.writeFileSync(
        path.join(home, newRaw),
        fs.readFileSync(path.join(home, oldRaw), "utf8").replaceAll(first, second),
      );
      for (const file of ["state_5.sqlite", "thread_history_1.sqlite"]) {
        const db = new DatabaseSync(nativeSqlitePath(path.join(home, file)));
        try {
          const tables = nativeProfile.databases
            .find((profile) => profile.file === file)
            .tables.filter((table) =>
              file === "state_5.sqlite"
                ? table.name === "threads"
                : table.columns.some((column) => column.name === "thread_id"),
            );
          for (const table of tables) {
            const columns = table.columns.map((column) => column.name),
              id = file === "state_5.sqlite" ? "id" : "thread_id";
            const expressions = columns.map((column) =>
              column === id || (file === "state_5.sqlite" && column === "rollout_path")
                ? "?"
                : '"' + column + '"',
            );
            const values = columns.flatMap((column) =>
              column === id
                ? [second]
                : file === "state_5.sqlite" && column === "rollout_path"
                  ? [path.join(home, newRaw)]
                  : [],
            );
            db.prepare(
              'INSERT INTO "' +
                table.name +
                '" (' +
                columns.map((column) => '"' + column + '"').join(",") +
                ") SELECT " +
                expressions.join(",") +
                ' FROM "' +
                table.name +
                '" WHERE "' +
                id +
                '"=?',
            ).run(...values, first);
          }
        } finally {
          db.close();
        }
      }
      let backupFilePublished = false,
        revoked = false,
        mutationDone = false;
      const denial = Object.assign(Error("Synthetic request revoked after backup"), {
        code: "SYNTHETIC_PREP_REVOKED",
      });
      const stoppedFixture = (home) =>
        prepareCodexNativeOffline({
          home,
          executable,
          probe: async () => {
            if (
              backupFilePublished &&
              !mutationDone &&
              ["revoked-after-backup", "raw-changed-after-backup"].includes(scenario)
            ) {
              mutationDone = true;
              if (scenario === "revoked-after-backup") revoked = true;
              else {
                const file = path.join(target, oldRaw),
                  changed = fs.readFileSync(file);
                changed[0] ^= 1;
                fs.writeFileSync(file, changed);
              }
            }
            if (
              backupFilePublished &&
              !mutationDone &&
              scenario === "operation-root-junction"
            ) {
              mutationDone = true;
              const operations = path.join(target, ".lode-native-portability"),
                canary = path.join(f.base, "operation-canary");
              fs.mkdirSync(canary);
              fs.writeFileSync(path.join(canary, "sentinel"), "unchanged");
              fs.renameSync(operations, operations + ".preserved");
              fs.symlinkSync(canary, operations, "junction");
            }
            return { status: "observed", rows: [] };
          },
          versionProbe: async () => ({
            status: "verified",
            version: nativeProfile.engineVersion,
          }),
        });
      const source = await stoppedFixture(home),
        captured = await captureCodexNativeHistory({
          witness: source.witness,
          threadIds: [first, second],
          destination: path.join(f.base, "two-native"),
        }),
        native = JSON.parse(fs.readFileSync(path.join(captured.directory, "manifest.json"))),
        target = path.join(f.base, "target-home"),
        cwd = path.join(f.base, "current-workspace");
      fs.mkdirSync(target);
      fs.mkdirSync(cwd);
      const state = syntheticNativeDatabase(
          t,
          "state_5.sqlite",
          path.join(target, "state_5.sqlite"),
        ),
        history = syntheticNativeDatabase(
          t,
          "thread_history_1.sqlite",
          path.join(target, "thread_history_1.sqlite"),
        );
      history.close();
      if (scenario === "partial-existing")
        state.row("threads", {
          id: second,
          rollout_path: path.join(target, newRaw),
          cwd,
          model: "USER_CURRENT",
          model_provider: "synthetic",
          reasoning_effort: "low",
          approval_mode: "never",
          sandbox_policy: "read-only",
        });
      let hooks;
      const symbol = Symbol.for("lode-test-native-registration");
      try {
        const targetOffline = await stoppedFixture(target);
        await publishCodexNativeHistory({
          witness: targetOffline.witness,
          directory: captured.directory,
        });
        const fixture = {
          target,
          cwd,
          first,
          second,
          files: native.files,
          state,
          calls: [],
          starts: 0,
          closes: 0,
          changeAtFirstClose: scenario === "external-edit",
          expectations: new Map(
            native.threadIds.map((id) => [id, codexNativeApiExpectation(native.history, id)]),
          ),
        };
        assert.equal(globalThis[symbol], undefined);
        globalThis[symbol] = fixture;
        const owner = new URL("../scripts/lib/distribution/codex-native-registration.mjs", import.meta.url);
        owner.search = "fixture=" + crypto.randomUUID();
        const fake = new URL("./helpers/native-registration-rpc-fixture.mjs", import.meta.url);
        hooks = registerHooks({
          resolve(specifier, context, next) {
            if (
              context.parentURL === owner.href &&
              specifier === "./codex-native-registration-rpc.mjs"
            )
              return { url: fake.href, shortCircuit: true };
            return next(specifier, context);
          },
        });
        const { registerCodexNativeHistory } = await import(owner.href);
        let boundaryHits = 0;
        const realLink = fs.linkSync;
        const registrationOptions = {
          witness: targetOffline.witness,
          directory: captured.directory,
          cwd,
          environment: { CODEX_HOME: target, HOME: target, USERPROFILE: target },
          supervisorSelection: { simulationOnly: true },
          controlFile: path.join(f.base, "unused-control"),
          assertCurrentAuthority() {
            if (revoked) throw denial;
          },
        };
        const stateFile = path.join(target, "state_5.sqlite");
        const rawBefore = fs.readFileSync(stateFile);
        const rawHistoryBefore = fs.readFileSync(path.join(target, "thread_history_1.sqlite"));
        if (scenario === "state-replaced") state.close();
        let result, preparationFailure;
        try {
          fs.linkSync = function (from, to, ...rest) {
            if (
              String(to).includes(path.sep + "before-state" + path.sep) &&
              path.basename(to) === "state_5.sqlite"
            ) {
              boundaryHits++;
              if (scenario === "backup-enospc")
                throw Object.assign(Error("Synthetic disk full"), { code: "ENOSPC" });
              if (scenario === "state-replaced") {
                fs.renameSync(stateFile, stateFile + ".external-original");
                fs.copyFileSync(stateFile + ".external-original", stateFile);
              }
            }
            const linked = realLink.call(this, from, to, ...rest);
            if (
              String(to).includes(path.sep + "before-state" + path.sep) &&
              path.basename(to) === "state_5.sqlite"
            )
              backupFilePublished = true;
            if (
              (scenario.startsWith("partial-") ||
                [
                  "snapshot-tamper",
                  "missing-member-result",
                  "snapshot-parent-tamper",
                  "group-initial-tamper",
                ].includes(scenario)) &&
              String(to).endsWith(".result.json")
            )
              revoked = true;
            if (scenario === "snapshot-only" && String(to).endsWith(".member-0.json"))
              revoked = true;
            return linked;
          };
          if (scenario === "concurrent") {
            const settled = await Promise.allSettled([
              registerCodexNativeHistory(registrationOptions),
              registerCodexNativeHistory(registrationOptions),
            ]);
            const completed = settled.filter(
              (item) =>
                item.status === "fulfilled" &&
                item.value.status === "native-registered-read-verified",
            );
            assert(
              completed.length >= 1,
              JSON.stringify(
                settled.map((item) =>
                  item.status === "fulfilled" ? item.value : item.reason.code,
                ),
              ),
            );
            for (const item of settled)
              if (item.status === "rejected")
                assert(
                  [
                    "NATIVE_CODEX_REGISTRATION_TARGET_APPEARED",
                    "NATIVE_CODEX_TARGET_BEFORE_GENERATION_CHANGED",
                    "NATIVE_CODEX_TARGET_CHOICES_CHANGED",
                  ].includes(item.reason.code),
                  item.reason.code,
                );
            for (const id of [first, second])
              assert.equal(
                fixture.calls.filter(
                  (call) => call.method === "thread/resume" && call.threadId === id,
                ).length,
                1,
              );
            result = completed[0].value;
          } else result = await registerCodexNativeHistory(registrationOptions);
        } catch (error) {
          preparationFailure = error;
        } finally {
          fs.linkSync = realLink;
        }
        if (
          scenario.startsWith("partial-") ||
          [
            "snapshot-only",
            "snapshot-tamper",
            "missing-member-result",
            "snapshot-parent-tamper",
            "group-initial-tamper",
          ].includes(scenario)
        ) {
          assert.equal(preparationFailure, denial);
          assert.equal(fixture.starts, 1);
          const model = (id) =>
            state.db.prepare("SELECT model FROM threads WHERE id=?").get(id).model;
          assert.equal(model(first), "CURRENT_TARGET");
          assert.equal(
            model(second),
            scenario === "partial-existing" ? "USER_CURRENT" : "SDK_DISCOVERED_SOURCE",
          );
          const operationRoot = path.join(target, ".lode-native-portability"),
            names = fs.readdirSync(operationRoot),
            member = names.find((name) => name.endsWith(".member-0.json"));
          assert(member);
          const resultFiles = names.filter((name) => name.endsWith(".result.json"));
          assert.equal(resultFiles.length, scenario === "snapshot-only" ? 0 : 1);
          if (scenario === "partial-user-edit")
            state.db.prepare("UPDATE threads SET model='EXTERNAL_USER' WHERE id=?").run(second);
          if (scenario === "snapshot-tamper")
            fs.appendFileSync(path.join(operationRoot, member), " ");
          if (scenario === "missing-member-result")
            fs.unlinkSync(path.join(operationRoot, resultFiles[0]));
          if (scenario === "snapshot-parent-tamper") {
            const file = path.join(operationRoot, member),
              document = JSON.parse(fs.readFileSync(file));
            fs.writeFileSync(
              file,
              JSON.stringify({ ...document, previousProgressDigest: "0".repeat(64) }, null, 2) +
                "\n",
            );
          }
          if (scenario === "group-initial-tamper") {
            const file = path.join(
                operationRoot,
                names.find(
                  (name) =>
                    /^codex-registration-group-.*\.json$/.test(name) &&
                    !name.includes(".member-"),
                ),
              ),
              document = JSON.parse(fs.readFileSync(file));
            document.initialMetadata[1].digest = "0".repeat(64);
            fs.writeFileSync(file, JSON.stringify(document, null, 2) + "\n");
          }
          revoked = false;
          if (
            [
              "partial-user-edit",
              "snapshot-tamper",
              "snapshot-parent-tamper",
              "group-initial-tamper",
            ].includes(scenario)
          ) {
            await assert.rejects(registerCodexNativeHistory(registrationOptions), {
              code:
                scenario === "partial-user-edit"
                  ? "NATIVE_CODEX_REGISTRATION_TARGET_APPEARED"
                  : scenario === "group-initial-tamper"
                    ? "NATIVE_REGISTRATION_JOURNAL_INVALID"
                    : "NATIVE_CODEX_REGISTRATION_GROUP_CHANGED",
            });
            assert.equal(fixture.starts, 1);
            assert.equal(
              model(second),
              scenario === "partial-user-edit" ? "EXTERNAL_USER" : "SDK_DISCOVERED_SOURCE",
            );
          } else {
            const resumed = await registerCodexNativeHistory(registrationOptions);
            const uncertain = ["snapshot-only", "missing-member-result"].includes(scenario);
            assert.equal(
              resumed.status,
              uncertain ? "native-registration-incomplete" : "native-registered-read-verified",
            );
            assert.equal(fixture.starts, uncertain ? 1 : 2);
            assert.equal(fixture.closes, fixture.starts);
            assert.equal(
              model(second),
              uncertain
                ? "SDK_DISCOVERED_SOURCE"
                : scenario === "partial-existing"
                  ? "USER_CURRENT"
                  : "CURRENT_TARGET",
            );
          }
          assert.equal(
            fixture.calls.filter(
              (call) => call.method === "thread/resume" && call.threadId === first,
            ).length,
            1,
          );
          assert.equal(
            fixture.calls.filter(
              (call) => call.method === "thread/resume" && call.threadId === second,
            ).length,
            scenario === "partial-resume" ? 1 : 0,
          );
          return;
        }
        if (scenario === "operation-root-junction") {
          assert.equal(preparationFailure?.code, "PROJECT_COPY_UNSAFE_PATH");
          assert.equal(fixture.starts, 0);
          const canary = path.join(f.base, "operation-canary");
          assert.deepEqual(fs.readdirSync(canary), ["sentinel"]);
          assert.equal(fs.readFileSync(path.join(canary, "sentinel"), "utf8"), "unchanged");
          return;
        }
        if (
          [
            "backup-enospc",
            "state-replaced",
            "revoked-after-backup",
            "raw-changed-after-backup",
          ].includes(scenario)
        ) {
          assert.equal(boundaryHits, 1);
          assert(preparationFailure);
          assert.equal(
            preparationFailure.code,
            {
              "backup-enospc": "ENOSPC",
              "state-replaced": "NATIVE_CODEX_TARGET_STATE_FILE_CHANGED",
              "revoked-after-backup": "SYNTHETIC_PREP_REVOKED",
              "raw-changed-after-backup": "NATIVE_CODEX_REGISTER_RAW_DIVERGED",
            }[scenario],
          );
          if (scenario === "revoked-after-backup") assert.equal(preparationFailure, denial);
          assert.equal(fixture.starts, 0);
          assert.equal(fixture.calls.length, 0);
          const operationRoot = path.join(target, ".lode-native-portability");
          assert.equal(
            fs.readdirSync(operationRoot).filter((name) => name.endsWith(".attempt.json"))
              .length,
            0,
          );
          assert.equal(
            fs.readdirSync(operationRoot).filter((name) => name.endsWith(".result.json"))
              .length,
            0,
          );
          assert(fs.readFileSync(stateFile).equals(rawBefore));
          assert(
            fs
              .readFileSync(path.join(target, "thread_history_1.sqlite"))
              .equals(rawHistoryBefore),
          );
          if (scenario !== "backup-enospc") return;
          result = await registerCodexNativeHistory(registrationOptions);
          assert.equal(result.status, "native-registered-read-verified");
          assert.equal(fixture.starts, 2);
          assert.equal(fixture.closes, 2);
          for (const id of [first, second])
            assert.equal(
              fixture.calls.filter(
                (call) => call.method === "thread/resume" && call.threadId === id,
              ).length,
              1,
            );
        } else if (scenario === "external-edit") {
          assert.equal(result.status, "native-registration-incomplete");
          assert.equal(
            result.results[0].primaryFailure.code,
            "NATIVE_CODEX_REGISTRATION_TARGET_APPEARED",
          );
          assert.equal(fixture.starts, 1);
          assert.equal(
            fixture.calls.filter(
              (call) => call.method === "thread/resume" && call.threadId === second,
            ).length,
            0,
          );
          assert.equal(
            state.db.prepare("SELECT model FROM threads WHERE id=?").get(second).model,
            "EXTERNAL_TARGET_EDIT",
          );
        } else {
          if (preparationFailure) throw preparationFailure;
          assert.equal(
            result.status,
            "native-registered-read-verified",
            JSON.stringify(result),
          );
          assert.equal(fixture.starts, 2);
          assert.equal(fixture.closes, 2);
          assert.equal(
            state.db.prepare("SELECT model FROM threads WHERE id=?").get(second).model,
            "CURRENT_TARGET",
          );
        }
        assert.equal(result.continuationReady, false);
        assert.equal(result.grantsRecoveryAuthority, false);
      } finally {
        hooks?.deregister();
        delete globalThis[symbol];
        state.close();
      }
    });
});

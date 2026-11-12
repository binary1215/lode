import fs from "node:fs";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { syntheticNativeCapture, nativeProfile } from "./helpers/native-portability-fixture.mjs";
import { nativeSqlitePath } from "../scripts/lib/distribution/codex-native-backup.mjs";
import {
  observeCodexNativeTargetChoices,
  verifyCodexNativeTargetChoices,
  backupCodexNativeTargetChoices,
} from "../scripts/lib/distribution/codex-native-target-choices.mjs";
import {
  selectCodexNativeRegistrationPolicy,
  verifyCodexNativeRegistrationPolicy,
} from "../scripts/lib/distribution/codex-native-registration.mjs";

test("native metadata verifies current explicit settings without source fallback or permission flattening", () => {
  const root = path.resolve("synthetic-current-workspace");
  const policy = selectCodexNativeRegistrationPolicy({
    model: "current-model",
    model_provider: "current-provider",
    model_reasoning_effort: "low",
    approval_policy: "never",
    sandbox_mode: "read-only",
  });
  assert.equal(policy.serviceTier, "default");
  const response = {
    thread: {
      id: "selected",
      cwd: root,
      environments: [{ environmentId: "local", cwd: root, runtimeWorkspaceRoots: [root] }],
    },
    cwd: root,
    runtimeWorkspaceRoots: [root],
    model: "current-model",
    modelProvider: "current-provider",
    reasoningEffort: "low",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    serviceTier: "default",
    sandbox: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
  };
  assert.doesNotThrow(() =>
    verifyCodexNativeRegistrationPolicy(response, policy, "selected", root),
  );
  for (const mutate of [
    (value) => {
      value.model = "historical-source-model";
    },
    (value) => {
      value.modelProvider = "source-provider";
    },
    (value) => {
      value.approvalPolicy = "untrusted";
    },
    (value) => {
      value.serviceTier = "fast";
    },
    (value) => {
      value.runtimeWorkspaceRoots.push(path.resolve("extra-root"));
    },
    (value) => {
      value.thread.environments[0].runtimeWorkspaceRoots = [];
    },
    (value) => {
      value.cwd = path.resolve("foreign-root");
    },
    (value) => {
      value.sandbox.networkAccess = true;
    },
    (value) => {
      value.sandbox.writableRoots = [root];
    },
    (value) => {
      value.activePermissionProfile = { id: "custom-current-profile" };
    },
  ]) {
    const changed = structuredClone(response);
    mutate(changed);
    assert.throws(() => verifyCodexNativeRegistrationPolicy(changed, policy, "selected", root));
  }
  assert.throws(() => selectCodexNativeRegistrationPolicy({}), {
    code: "NATIVE_CODEX_CURRENT_POLICY_UNRESOLVED",
  });
  assert.throws(
    () =>
      selectCodexNativeRegistrationPolicy({
        model: "current-model",
        model_provider: "current-provider",
        model_reasoning_effort: "low",
        approval_policy: "never",
        sandbox_mode: "workspace-write",
      }),
    { code: "NATIVE_CODEX_WORKSPACE_POLICY_PROFILE_UNVERIFIED" },
  );
  const full = selectCodexNativeRegistrationPolicy({
    model: "current-model",
    model_provider: "current-provider",
    model_reasoning_effort: "low",
    approval_policy: "never",
    sandbox_mode: "danger-full-access",
  });
  assert.doesNotThrow(() =>
    verifyCodexNativeRegistrationPolicy(
      { ...response, sandbox: { type: "dangerFullAccess" } },
      full,
      "selected",
      root,
    ),
  );
});

test("preexisting target choices stay protected while cache refresh, selected updates and new rows remain distinct", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64")
    return t.skip("Measured native filesystem profile is Windows x64.");
  const { home, payload } = await syntheticNativeCapture(t),
    db = new DatabaseSync(nativeSqlitePath(path.join(home, "state_5.sqlite")));
  const first = payload.threadIds[0],
    other = "01900000-0000-7000-8000-000000000008",
    extra = "01900000-0000-7000-8000-000000000009";
  try {
    // Author an independent current-target row from pinned test columns only.
    const columns = nativeProfile.databases
      .find((entry) => entry.file === "state_5.sqlite")
      .tables.find((entry) => entry.name === "threads")
      .columns.map((entry) => entry.name);
    db.prepare(
      "INSERT INTO threads (" +
        columns.map((name) => '"' + name + '"').join(",") +
        ") SELECT " +
        columns.map((name) => (name === "id" ? "?" : '"' + name + '"')).join(",") +
        " FROM threads WHERE id=?",
    ).run(other, first);
    db.prepare(
      "UPDATE threads SET model='existing-user-choice',creator_account_id='DO_NOT_QUERY',first_user_message='DO_NOT_QUERY',preview='DO_NOT_QUERY' WHERE id=?",
    ).run(other);
    const options = { deadlineAt: Date.now() + 60000, assertCurrentAuthority() {} },
      basis = {
        engineVersion: nativeProfile.engineVersion,
        platform: process.platform,
        architecture: process.arch,
      };
    const originalPrepare = DatabaseSync.prototype.prepare,
      queries = [];
    let witness;
    try {
      DatabaseSync.prototype.prepare = function (sql) {
        queries.push(sql);
        return originalPrepare.call(this, sql);
      };
      witness = observeCodexNativeTargetChoices({
        home,
        basis,
        selectedThreadIds: [first],
        ...options,
      });
      assert.equal(verifyCodexNativeTargetChoices(witness, options).protectedRows, 1);
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
    }
    assert(
      !queries.some((sql) =>
        /creator_user_id|creator_account_id|first_user_message|preview/.test(sql),
      ),
    );
    db.prepare("UPDATE threads SET recency_at=99,preview='new cache',updated_at=99 WHERE id=?").run(
      other,
    );
    db.prepare("UPDATE threads SET model='new selected target policy' WHERE id=?").run(first);
    db.prepare(
      "INSERT INTO threads (" +
        columns.map((name) => '"' + name + '"').join(",") +
        ") SELECT " +
        columns.map((name) => (name === "id" ? "?" : '"' + name + '"')).join(",") +
        " FROM threads WHERE id=?",
    ).run(extra, first);
    const changedCache = verifyCodexNativeTargetChoices(witness, options);
    assert.equal(changedCache.protectedRows, 1);
    assert.equal(changedCache.additionalRowsObserved, 1);
    assert.equal(changedCache.newRowOrigin, "not-inferred");
    const operationRoot = path.join(home, ".lode-native-portability");
    fs.mkdirSync(operationRoot, { recursive: true });
    const backupOptions = {
      operationRoot,
      operationId: "native-registration-" + "a".repeat(24),
      ...options,
    };
    const beforeBackup = await backupCodexNativeTargetChoices(witness, backupOptions);
    assert.equal(beforeBackup.transferred, false);
    assert.equal(beforeBackup.grantsRecoveryAuthority, false);
    const local = path.join(home, beforeBackup.path),
      beforeBytes = fs.readFileSync(local);
    assert.equal((await backupCodexNativeTargetChoices(witness, backupOptions)).reused, true);
    db.prepare("UPDATE threads SET preview='newer derived cache' WHERE id=?").run(other);
    const nextBackup = await backupCodexNativeTargetChoices(witness, backupOptions);
    assert.notEqual(nextBackup.path, beforeBackup.path);
    assert(fs.readFileSync(local).equals(beforeBytes));
    const currentBackup = path.join(home, nextBackup.path),
      receipt = path.join(path.dirname(currentBackup), "backup.json");
    fs.writeFileSync(currentBackup, "Not a SQLite backup");
    const originalReceipt = JSON.parse(fs.readFileSync(receipt));
    fs.writeFileSync(
      receipt,
      JSON.stringify({
        ...originalReceipt,
        bytes: fs.statSync(currentBackup).size,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(currentBackup)).digest("hex"),
      }),
    );
    await assert.rejects(
      backupCodexNativeTargetChoices(witness, backupOptions),
      "rewritten checksum metadata cannot make a non-SQLite backup usable",
    );
    db.prepare("UPDATE threads SET preview=? WHERE id=?").run("x".repeat(1024 * 1024), other);
    const sourceBefore = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(home, "state_5.sqlite")))
      .digest("hex");
    const generationRoot = path.join(operationRoot, "before-state", backupOptions.operationId),
      olderGenerations = new Set(fs.readdirSync(generationRoot));
    let revoked = false,
      steps = 0;
    await assert.rejects(
      backupCodexNativeTargetChoices(witness, {
        ...backupOptions,
        onBoundary(stage) {
          if (stage === "backup-step") {
            steps++;
            revoked = true;
          }
        },
        assertCurrentAuthority() {
          if (revoked)
            throw Object.assign(Error("Synthetic backup authority changed"), {
              code: "SYNTHETIC_BACKUP_REVOKED",
            });
        },
      }),
      { code: "SYNTHETIC_BACKUP_REVOKED" },
    );
    assert.equal(steps, 1);
    const pending = fs.readdirSync(generationRoot).filter((name) => !olderGenerations.has(name));
    assert.equal(pending.length, 1);
    assert(!fs.existsSync(path.join(generationRoot, pending[0], "backup.json")));
    assert.equal(
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(home, "state_5.sqlite")))
        .digest("hex"),
      sourceBefore,
    );
    db.prepare("UPDATE threads SET model='external-current-choice' WHERE id=?").run(other);
    assert.throws(() => verifyCodexNativeTargetChoices(witness, options), {
      code: "NATIVE_CODEX_TARGET_CHOICES_CHANGED",
    });
    assert.equal(
      db.prepare("SELECT model FROM threads WHERE id=?").get(other).model,
      "external-current-choice",
      "verification does not restore a whole backup over an external edit",
    );
    assert.throws(
      () => verifyCodexNativeTargetChoices(witness, { ...options, deadlineAt: Date.now() - 1 }),
      { code: "NATIVE_CODEX_REGISTRATION_DEADLINE" },
    );
    const denied = Object.assign(Error("Synthetic current denial"), { code: "SYNTHETIC_DENIED" });
    assert.throws(
      () =>
        verifyCodexNativeTargetChoices(witness, {
          ...options,
          assertCurrentAuthority() {
            throw denied;
          },
        }),
      (error) => error === denied,
    );
    assert.throws(() => verifyCodexNativeTargetChoices({}, options), {
      code: "NATIVE_CODEX_TARGET_CHOICES_WITNESS_REQUIRED",
    });
  } finally {
    db.close();
  }
});

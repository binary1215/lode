import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureWorkerSourceBasis, verifyWorkerSourceBasis } from "../scripts/lib/worker-source-basis.mjs";
import { prepareWorkerWorkspace, verifyWorkerWorkspace, collectWorkerWorkspacePatch } from "../scripts/lib/worker-workspace.mjs";
import { captureWorkerWriteBasis } from "../scripts/lib/worker-patch-basis.mjs";

console.log(
  JSON.stringify({
    event: "owned-worker-workspace-test",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);

function fixture(t) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-selected-workspace-"));
  const root = path.join(container, "project");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "dirty.txt"), "selected dirty bytes Ω\r\n");
  fs.writeFileSync(path.join(root, "untracked.txt"), "untracked bytes");
  fs.mkdirSync(path.join(root, ".head"));
  fs.writeFileSync(path.join(root, ".head", "private.json"), "not child input");
  fs.mkdirSync(path.join(root, ".lode"));
  fs.writeFileSync(path.join(root, ".lode", "private.json"), "not child input");
  t.after(() => {
    assert.equal(path.dirname(container), parent);
    assert.match(path.basename(container), /^head-selected-workspace-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  const sourceBasis = captureWorkerSourceBasis({ root, paths: ["untracked.txt", "src/dirty.txt"], maxBytes: 4096 });
  return { root, container, sourceBasis, workspaceRoot: path.join(container, "child") };
}

test("selected workspace retains dirty/untracked bytes without copying Canon or claiming a sandbox", (t) => {
  const f = fixture(t);
  const binding = prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: f.workspaceRoot, sourceBasis: f.sourceBasis, maxBytes: 4096 });
  assert.equal(binding.sandboxEnforced, false);
  assert.equal(binding.recoveryAuthority, false);
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, ".head")), false);
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, ".lode")), false);
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, ".git")), false);
  assert.equal(fs.readFileSync(path.join(f.workspaceRoot, "src/dirty.txt"), "utf8"), "selected dirty bytes Ω\r\n");
  assert.equal(verifyWorkerWorkspace({ binding, sourceBasis: f.sourceBasis }).executionRoot, f.workspaceRoot);
  fs.writeFileSync(path.join(f.root, "src/dirty.txt"), "new parent edit");
  // Historical selected bytes survive parent drift. A new execution's current
  // source gate is separate; this helper never claims permission to execute.
  verifyWorkerWorkspace({ binding, sourceBasis: f.sourceBasis });
  assert.throws(() => prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: f.workspaceRoot, sourceBasis: f.sourceBasis, maxBytes: 4096 }), {
    code: "EEXIST",
  });
  assert.equal(fs.readFileSync(path.join(f.root, "src/dirty.txt"), "utf8"), "new parent edit");
});

test("workspace preflight rejects changed, missing, extra, aliased and linked source evidence", (t) => {
  const f = fixture(t);
  const binding = prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: f.workspaceRoot, sourceBasis: f.sourceBasis, maxBytes: 4096 });
  const check = () => verifyWorkerWorkspace({ binding, sourceBasis: f.sourceBasis });
  const file = path.join(f.workspaceRoot, "untracked.txt");
  fs.writeFileSync(file, "changed");
  assert.throws(check, { code: "WORKER_WORKSPACE_CONFLICT" });
  fs.writeFileSync(file, "untracked bytes");
  fs.writeFileSync(path.join(f.workspaceRoot, "extra.txt"), "extra");
  assert.throws(check, { code: "WORKER_WORKSPACE_CONFLICT" });
  fs.unlinkSync(path.join(f.workspaceRoot, "extra.txt"));
  fs.linkSync(file, path.join(f.container, "alias"));
  assert.throws(check, { code: "INVALID_WORKER_SOURCE_BASIS" });
  fs.unlinkSync(path.join(f.container, "alias"));
  fs.unlinkSync(file);
  assert.throws(check, { code: "WORKER_WORKSPACE_CONFLICT" });
  fs.mkdirSync(file);
  assert.throws(check, { code: "WORKER_WORKSPACE_CONFLICT" });
});

test("wide root inode identities never collapse through Number before same-byte replacement checks", (t) => {
  const f = fixture(t),
    originalStat = fs.statSync;
  const beforeInode = 2n ** 60n,
    afterInode = beforeInode + 1n;
  assert.equal(Number(beforeInode), Number(afterInode), "The deterministic fault must exercise precision loss.");
  let replaced = false;
  fs.statSync = (file, options) => {
    const stat = originalStat(file, options);
    if (file !== f.workspaceRoot) return stat;
    const inode = replaced ? afterInode : beforeInode;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: options?.bigint ? inode : Number(inode) });
  };
  try {
    const binding = prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: f.workspaceRoot, sourceBasis: f.sourceBasis, maxBytes: 4096 });
    verifyWorkerWorkspace({ binding, sourceBasis: f.sourceBasis });
    const retained = path.join(f.container, "retained-root");
    fs.renameSync(f.workspaceRoot, retained);
    fs.cpSync(retained, f.workspaceRoot, { recursive: true, errorOnExist: true, force: false });
    replaced = true;
    assert.throws(() => verifyWorkerWorkspace({ binding, sourceBasis: f.sourceBasis }), { code: "WORKER_WORKSPACE_CONFLICT" });
    assert.equal(binding.rootInode, String(beforeInode));
  } finally {
    fs.statSync = originalStat;
  }
});

test("workspace creation never reuses canonical root or traverses an injected junction", (t) => {
  const f = fixture(t);
  assert.throws(() => prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: path.join(f.root, "child"), sourceBasis: f.sourceBasis, maxBytes: 4096 }), {
    code: "WORKER_WORKSPACE_CONFLICT",
  });
  assert.equal(fs.existsSync(path.join(f.root, "child")), false);
  const alias = path.join(f.container, "alias");
  fs.symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: path.join(alias, "child"), sourceBasis: f.sourceBasis, maxBytes: 4096 }), {
    code: "WORKER_WORKSPACE_CONFLICT",
  });
  assert.equal(fs.existsSync(path.join(f.root, "child")), false);
});

test("workspace rejects platform path alias before materializing any source", { skip: process.platform !== "win32" }, (t) => {
  const f = fixture(t);
  const entry = f.sourceBasis[0];
  for (const paths of [["A.txt", "a.txt"], ["NUL"], ["aux.txt"], ["a?.txt"]]) {
    const sourceBasis = paths.map((relative) => ({ ...entry, path: relative })).sort((a, b) => (a.path < b.path ? -1 : 1));
    assert.throws(() => prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: f.workspaceRoot, sourceBasis, maxBytes: 4096 }), {
      code: "WORKER_WORKSPACE_CONFLICT",
    });
    assert.equal(fs.existsSync(f.workspaceRoot), false);
  }
});

test("source basis rejects missing and non-finite bounds instead of silently reading unbounded data", (t) => {
  const f = fixture(t);
  for (const maxBytes of [undefined, NaN, Infinity, -1, 1.5]) {
    assert.throws(() => captureWorkerSourceBasis({ root: f.root, paths: [], maxBytes }), { code: "INVALID_WORKER_SOURCE_BASIS" });
    assert.throws(() => verifyWorkerSourceBasis([], maxBytes), { code: "INVALID_WORKER_SOURCE_BASIS" });
  }
});

test("workspace output collection preserves semantic mode, captures creation/deletion and refuses unowned edits", (t) => {
  const f = fixture(t);
  if (process.platform !== "win32") fs.chmodSync(path.join(f.root, "src/dirty.txt"), 0o755);
  const writeBasis = captureWorkerWriteBasis({ root: f.root, paths: ["src/dirty.txt", "new.txt"], maxBytes: 4096 });
  const binding = prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: f.workspaceRoot, sourceBasis: f.sourceBasis, maxBytes: 4096 });
  fs.writeFileSync(path.join(f.workspaceRoot, "src/dirty.txt"), "worker edited bytes");
  fs.writeFileSync(path.join(f.workspaceRoot, "new.txt"), "worker new file");
  const collect = () => collectWorkerWorkspacePatch({ binding, sourceBasis: f.sourceBasis, writeBasis });
  const candidate = collect();
  assert.equal(
    candidate.patches.find((patch) => patch.after.path === "src/dirty.txt").after.mode,
    writeBasis.find((entry) => entry.path === "src/dirty.txt").mode,
  );
  assert.equal(candidate.patches.find((patch) => patch.after.path === "new.txt").before.kind, "absent");
  assert.equal(fs.existsSync(path.join(f.root, "new.txt")), false);
  fs.unlinkSync(path.join(f.workspaceRoot, "src/dirty.txt"));
  assert.equal(collect().patches.find((patch) => patch.after.path === "src/dirty.txt").after.kind, "absent");
  fs.writeFileSync(path.join(f.workspaceRoot, "untracked.txt"), "unowned edit");
  assert.throws(collect, { code: "WORKER_PATCH_OUTSIDE_OWNERSHIP" });
  assert.equal(fs.readFileSync(path.join(f.root, "untracked.txt"), "utf8"), "untracked bytes");
});

for (const mutation of ["new-file", "earlier-bytes", "same-bytes-replacement"]) {
  test(`workspace collection rejects mid-collection ${mutation} without changing Canon`, (t) => {
    const f = fixture(t);
    const writeBasis = captureWorkerWriteBasis({ root: f.root, paths: ["src/dirty.txt"], maxBytes: 4096 });
    const binding = prepareWorkerWorkspace({ projectRoot: f.root, workspaceRoot: f.workspaceRoot, sourceBasis: f.sourceBasis, maxBytes: 4096 });
    const originalOpen = fs.openSync;
    const first = path.join(f.workspaceRoot, "src/dirty.txt");
    const second = path.join(f.workspaceRoot, "untracked.txt");
    let injected = false;
    fs.openSync = function (file, ...args) {
      if (!injected && typeof file === "string" && path.resolve(file) === (mutation === "new-file" ? first : second)) {
        injected = true;
        if (mutation === "new-file") fs.writeFileSync(path.join(f.workspaceRoot, "unexpected.txt"), "unexpected");
        else if (mutation === "earlier-bytes") fs.writeFileSync(first, "changed after capture");
        else {
          // Keep the original inode alive to prevent filesystem inode reuse.
          fs.renameSync(first, path.join(f.container, "retained-original"));
          fs.writeFileSync(first, "selected dirty bytes Ω\r\n");
        }
      }
      return originalOpen.call(fs, file, ...args);
    };
    try {
      assert.throws(() => collectWorkerWorkspacePatch({ binding, sourceBasis: f.sourceBasis, writeBasis }), { code: "WORKER_WORKSPACE_CONFLICT" });
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(path.join(f.root, "src/dirty.txt"), "utf8"), "selected dirty bytes Ω\r\n");
    assert.equal(fs.existsSync(path.join(f.root, "unexpected.txt")), false);
  });
}

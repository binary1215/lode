import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeProposalOperationalDirectory } from "../scripts/lib/runtime/runtime-claude-proposal.mjs";

// Every Claude worker of a Project creates and removes the two shared parents
// runtime-claude-proposals and runtime-claude-proposals/<projectId>. Another
// worker may do the same between this worker's steps; each case forces one such
// interleaving. The worker's own folder keeps its strict checks.
const authorization = { projectId: "project-0123456789abcdef", authorizationId: "execution-authorization-0123456789abcdef01234567" };
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "head-claude-folders-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, "runtime-claude-proposals");
  const project = path.join(parent, authorization.projectId);
  return { root, parent, project, own: path.join(project, authorization.authorizationId), sibling: path.join(project, "execution-authorization-sibling") };
}
function patch(method, replacement) {
  const original = fs[method];
  fs[method] = function (...args) {
    return replacement.call(this, original, ...args);
  };
  return () => {
    fs[method] = original;
  };
}

test("cleanup loses shared-parent races without failing and keeps other failures strict", async (t) => {
  const cases = [
    { name: "project folder removed before lstat", method: "lstatSync", race: "remove" },
    { name: "project folder removed before realpath", method: "realpathSync", race: "remove" },
    { name: "project folder removed before readdir", method: "readdirSync", race: "remove" },
    { name: "project folder removed before rmdir", method: "rmdirSync", race: "remove" },
    { name: "member created before rmdir", method: "rmdirSync", race: "member" },
    ...(process.platform === "win32"
      ? [
          { name: "delete-pending EPERM at rmdir for a removed folder", method: "rmdirSync", race: "remove", error: "EPERM" },
          { name: "delete-pending EBUSY at rmdir for a removed folder", method: "rmdirSync", race: "remove", error: "EBUSY" },
          { name: "delete-pending EPERM at lstat for a removed folder", method: "lstatSync", race: "remove", error: "EPERM" },
        ]
      : []),
    // Past the safety check, Windows EPERM/EBUSY on a shared parent means another
    // worker is using it: it is left as it is. Elsewhere EPERM stays an error.
    ...(process.platform === "win32"
      ? [
          { name: "EPERM at rmdir for a shared parent that is still there", method: "rmdirSync", race: "none", error: "EPERM", left: true },
          { name: "EBUSY at readdir for a shared parent that is still there", method: "readdirSync", race: "none", error: "EBUSY", left: true },
        ]
      : [{ name: "EPERM for a folder that is still there", method: "rmdirSync", race: "none", error: "EPERM", rejects: "EPERM" }]),
    { name: "EIO before realpath", method: "lstatSync", race: "none", error: "EIO", rejects: "EIO" },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, (t) => {
      const s = scratch(t);
      const folders = claudeProposalOperationalDirectory(s.root, authorization);
      fs.writeFileSync(folders.controlFile, "{}\n");
      const rmdir = fs.rmdirSync;
      let triggered = false;
      const restore = patch(scenario.method, function (original, file, ...args) {
        // Only the shared-parent cleanup reaches the project folder after the
        // worker's own folder is gone.
        if (!triggered && file === s.project && !fs.existsSync(s.own)) {
          triggered = true;
          if (scenario.race === "remove") rmdir.call(fs, s.project);
          if (scenario.race === "member") fs.mkdirSync(s.sibling);
          if (scenario.error) throw Object.assign(new Error(`Synthetic ${scenario.error}`), { code: scenario.error, path: file });
        }
        return original.call(this, file, ...args);
      });
      try {
        if (scenario.rejects) assert.throws(() => folders.cleanup(), { code: scenario.rejects });
        else folders.cleanup();
      } finally {
        restore();
      }
      assert.equal(triggered, true);
      if (scenario.rejects) return;
      assert.equal(fs.existsSync(s.own), false);
      assert.equal(fs.existsSync(s.project), scenario.race === "member" || scenario.left === true);
      if (scenario.race === "member") assert.deepEqual(fs.readdirSync(s.project), [path.basename(s.sibling)]);
    });
  }
});

test("creation recreates a shared parent another worker removed under it", async (t) => {
  for (const removed of ["project", "parent"]) {
    await t.test(`${removed} folder removed before the worker's own folder is made`, (t) => {
      const s = scratch(t);
      const rmdir = fs.rmdirSync;
      let triggered = false;
      const restore = patch("mkdirSync", function (original, file, ...args) {
        if (!triggered && file === s.own) {
          triggered = true;
          rmdir.call(fs, s.project);
          if (removed === "parent") rmdir.call(fs, s.parent);
        }
        return original.call(this, file, ...args);
      });
      let folders;
      try {
        folders = claudeProposalOperationalDirectory(s.root, authorization);
      } finally {
        restore();
      }
      assert.equal(triggered, true);
      assert.equal(fs.lstatSync(s.own).isDirectory(), true);
      folders.cleanup();
      assert.equal(fs.existsSync(s.parent), false);
    });
  }
});

test("the worker's own folder stays strict: an unexpected file fails cleanup and keeps the folder", (t) => {
  const s = scratch(t);
  const folders = claudeProposalOperationalDirectory(s.root, authorization);
  fs.writeFileSync(path.join(s.own, "unexpected.txt"), "x");
  assert.throws(() => folders.cleanup(), { code: "CLAUDE_FRESH_PROPOSAL_UNEXPECTED_OPERATIONAL_FILE" });
  assert.equal(fs.existsSync(s.own), true);
});

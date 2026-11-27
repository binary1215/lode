import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeProposalOperationalDirectory } from "../scripts/lib/runtime/runtime-claude-proposal.mjs";
import { codexProposalOperationalFiles } from "../scripts/lib/runtime/runtime-codex-proposal.mjs";

// The shared operational parents are checked one level at a time before anything
// is created inside them: a parent that is a link (a junction on Windows) or a
// file is refused, and nothing is created on the other side of a link.
const authorization = { projectId: "project-0123456789abcdef", authorizationId: "execution-authorization-0123456789abcdef01234567" };
const backends = [
  { name: "Claude", build: claudeProposalOperationalDirectory, top: "runtime-claude-proposals", unsafe: "CLAUDE_FRESH_PROPOSAL_UNSAFE_OPERATIONAL_PATH" },
  { name: "Codex", build: codexProposalOperationalFiles, top: "runtime-fresh-proposals", unsafe: "CODEX_FRESH_PROPOSAL_UNSAFE_OPERATIONAL_PATH" },
];
function scratch(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "head-proposal-safety-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "operational"),
    outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  return { root, outside };
}
const link = (target, at) => fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");

for (const backend of backends) {
  test(`${backend.name} refuses a linked shared parent and creates nothing behind it`, async (t) => {
    for (const level of ["top", "project"]) {
      await t.test(`${level} parent is a link`, (t) => {
        const s = scratch(t);
        const top = path.join(s.root, backend.top);
        if (level === "top") link(s.outside, top);
        else {
          fs.mkdirSync(top);
          link(s.outside, path.join(top, authorization.projectId));
        }
        assert.throws(() => backend.build(s.root, authorization), { code: backend.unsafe });
        assert.deepEqual(fs.readdirSync(s.outside), [], "nothing created on the other side of the link");
      });
    }
  });

  test(`${backend.name} refuses a file in place of a shared parent with its safety check`, async (t) => {
    for (const level of ["top", "project"]) {
      await t.test(`${level} parent is a file`, (t) => {
        const s = scratch(t);
        const top = path.join(s.root, backend.top);
        if (level === "top") fs.writeFileSync(top, "not a folder");
        else {
          fs.mkdirSync(top);
          fs.writeFileSync(path.join(top, authorization.projectId), "not a folder");
        }
        assert.throws(() => backend.build(s.root, authorization), { code: backend.unsafe });
      });
    }
  });
}

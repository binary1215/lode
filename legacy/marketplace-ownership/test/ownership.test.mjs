import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { snapshotInventory, verifyHistoricalMarketplaceOwnership, verifyHistoricalSupervisorManifest } from "../verify.mjs";
import { verifyProcessSupervisorManifest } from "../../../scripts/lib/runtime/runtime-process-supervisor.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function identify(payload) {
  const copy = structuredClone(payload);
  delete copy.manifestId;
  delete copy.manifestHash;
  const digest = hash(canonical(copy));
  return { ...copy, manifestId: `process-supervisor-manifest-${digest.slice(0, 24)}`, manifestHash: digest };
}
function historical() {
  return identify({
    schemaVersion: 1,
    kind: "HeadAgentProcessSupervisorManifest",
    manifestVersion: "0.1.0",
    supervisorProtocolVersion: "0.1.0",
    target: { platform: "linux", arch: "x64", directory: "linux-x64" },
    binary: { relativePath: "head-agent-supervisor", sha256: hash("synthetic non-executable fixture"), size: 32 },
    processModel: {
      transport: "single-request-stdio-with-control-fd3",
      windowsTreeOwnership: "job-object-kill-on-close",
      posixTreeOwnership: "isolated-process-group",
      shellInterpretation: false,
    },
    authority: { kind: "operational-process-control-only", instructionAuthority: false, promotionAuthority: false, mutatesCanon: false },
  });
}
const scope = { platform: "linux", arch: "x64" };
const rejected = { code: "LEGACY_MARKETPLACE_OWNERSHIP_REJECTED" };
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "head-historical-ownership-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("known historical schema is inspection-only; current runtime still rejects it", () => {
  const manifest = historical(),
    before = structuredClone(manifest);
  assert.deepEqual(verifyHistoricalSupervisorManifest(manifest, scope), before);
  assert.deepEqual(manifest, before);
  assert.throws(() => verifyProcessSupervisorManifest(manifest, scope), { code: "INVALID_PROCESS_SUPERVISOR_MANIFEST" });
});

test("rehashing cannot bless unknown schema, capabilities, authority, target or binary path", () => {
  for (const change of [
    (m) => {
      m.schemaVersion = 2;
    },
    (m) => {
      m.manifestVersion = "0.2.0";
    },
    (m) => {
      m.supervisorProtocolVersion = "9.0.0";
    },
    (m) => {
      m.capabilities = {};
    },
    (m) => {
      m.authority.instructionAuthority = true;
    },
    (m) => {
      m.authority.grantsWriteAuthorization = false;
    },
    (m) => {
      m.processModel.shellInterpretation = true;
    },
    (m) => {
      m.target.directory = "other";
    },
    (m) => {
      m.binary.relativePath = "../head-agent-supervisor";
    },
    (m) => {
      m.binary.extra = true;
    },
    (m) => {
      m.binary.size = 0;
    },
    (m) => {
      m.binary.sha256 = "bad";
    },
  ]) {
    const manifest = historical();
    change(manifest);
    assert.throws(() => verifyHistoricalSupervisorManifest(identify(manifest), scope), rejected);
  }
});

test("manifest digest and id, not only payload, must match", () => {
  for (const field of ["manifestHash", "manifestId"]) {
    const manifest = historical();
    manifest[field] += "x";
    assert.throws(() => verifyHistoricalSupervisorManifest(manifest, scope), rejected);
  }
  assert.throws(() => verifyHistoricalSupervisorManifest(historical(), { platform: "unknown", arch: "x64" }), rejected);
});

test("ownership requires exact provider, repository, marketplace and historical commit", (t) => {
  const root = temporary(t);
  const valid = {
    root,
    provider: "codex",
    expectedRepository: "binary1215/head-agent-plugin",
    expectedMarketplaceName: "head-agent-plugin",
    expectedSnapshotCommit: "559f38e955a9ea79512d551afcf209391ca631bc",
  };
  for (const field of Object.keys(valid).filter((key) => key !== "root")) {
    assert.throws(() => verifyHistoricalMarketplaceOwnership({ ...valid, [field]: "unknown" }), rejected);
    const missing = { ...valid };
    delete missing[field];
    assert.throws(() => verifyHistoricalMarketplaceOwnership(missing), rejected);
  }
  // Even correct-looking scope cannot bless an arbitrary tree.
  assert.throws(() => verifyHistoricalMarketplaceOwnership(valid), rejected);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("inventory is deterministic and includes empty directories and exact bytes", (t) => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, "empty"));
  fs.writeFileSync(path.join(root, "z.txt"), "LF\n");
  fs.writeFileSync(path.join(root, "a.txt"), "A");
  const expected = [
    { path: "a.txt", type: "file", bytes: 1, sha256: hash("A") },
    { path: "empty", type: "directory" },
    { path: "z.txt", type: "file", bytes: 3, sha256: hash("LF\n") },
  ];
  assert.deepEqual(snapshotInventory(root), expected);
  fs.writeFileSync(path.join(root, "z.txt"), "LF\r\n");
  assert.notEqual(hash(JSON.stringify(snapshotInventory(root))), hash(JSON.stringify(expected)));
});

test("inventory rejects symlink or Windows junction instead of following it", (t) => {
  const root = temporary(t),
    external = temporary(t);
  const link = path.join(root, "link");
  fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
  t.after(() => {
    if (fs.existsSync(link)) fs.unlinkSync(link);
  });
  assert.throws(() => snapshotInventory(root), rejected);
});

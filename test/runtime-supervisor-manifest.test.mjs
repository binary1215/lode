import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createProcessSupervisorManifest,
  resolveVerifiedProcessSupervisor,
  verifyProcessSupervisorManifest,
  PROCESS_SUPERVISOR_MANIFEST_VERSION,
  PROCESS_SUPERVISOR_PROTOCOL_VERSION,
  PROCESS_SUPERVISOR_INTERACTIVE_PROTOCOL_VERSION,
} from "../scripts/lib/runtime-process-supervisor.mjs";

console.log(
  JSON.stringify({
    event: "supervisor-manifest-test",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    nativeExecutionPerformed: false,
  }),
);

const targets = [
  ["win32", "x64", "windows-x64", "lode-agent-supervisor.exe"],
  ["linux", "x64", "linux-x64", "lode-agent-supervisor"],
  ["linux", "arm64", "linux-arm64", "lode-agent-supervisor"],
  ["darwin", "x64", "darwin-x64", "lode-agent-supervisor"],
  ["darwin", "arm64", "darwin-arm64", "lode-agent-supervisor"],
];

function fixture(t, target = targets.find(([platform, arch]) => platform === process.platform && arch === process.arch)) {
  assert.ok(target, "Test requires a supported manifest target.");
  const [platform, arch, directory, filename] = target;
  const root = fs.mkdtempSync(path.join(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "head-supervisor-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestDirectory = path.join(root, "dist", directory);
  fs.mkdirSync(manifestDirectory, { recursive: true });
  const binaryFile = path.join(manifestDirectory, filename);
  // Deliberately non-executable content: verifying a declaration cannot prove
  // actual platform support or grant an effect authorization.
  fs.writeFileSync(binaryFile, "synthetic manifest fixture; never executed", { flag: "wx", mode: 0o755 });
  const manifest = createProcessSupervisorManifest({ platform, arch, binaryFile, manifestDirectory });
  const manifestFile = path.join(manifestDirectory, "SUPERVISOR-MANIFEST.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), { flag: "wx" });
  return { root, platform, arch, manifest, manifestFile, binaryFile };
}

function reidentify(value) {
  const sort = (item) =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort(item[key])]),
          )
        : item;
  delete value.manifestId;
  delete value.manifestHash;
  const manifestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(sort(value)))
    .digest("hex");
  return { ...value, manifestHash, manifestId: `process-supervisor-manifest-${manifestHash.slice(0, 24)}` };
}

test("manifest declares process and file-effect protocols without platform capability or Core authority", (t) => {
  for (const target of targets) {
    const f = fixture(t, target);
    const manifest = verifyProcessSupervisorManifest(f.manifest, f);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.manifestVersion, "0.3.0");
    assert.equal(manifest.manifestVersion, PROCESS_SUPERVISOR_MANIFEST_VERSION);
    assert.equal(manifest.supervisorProtocolVersion, PROCESS_SUPERVISOR_PROTOCOL_VERSION);
    assert.equal(manifest.capabilities.declarationOnly, true);
    assert.deepEqual(manifest.capabilities.processSupervision, {
      oneShotProtocolVersion: "0.1.0",
      jobProtocolVersion: "0.1.0",
      detachedJobAvailability: "runtime-platform-preflight-required",
      interactiveProtocolVersion: "0.1.0",
      interactiveTransport: "bounded-bootstrap-line-streaming-stdio",
    });
    assert.equal(manifest.capabilities.processSupervision.interactiveProtocolVersion, PROCESS_SUPERVISOR_INTERACTIVE_PROTOCOL_VERSION);
    assert.deepEqual(manifest.processModel, {
      transport: "single-request-stdio-with-control-fd3",
      windowsTreeOwnership: "job-object-kill-on-close",
      posixTreeOwnership: "isolated-process-group",
      shellInterpretation: false,
    });
    assert.deepEqual(manifest.capabilities.fileEffects, {
      transport: "single-request-stdio",
      transportProtocolVersion: "0.1.0",
      imageProtocolVersion: "0.1.0",
      operations: ["probe", "inspect", "edit", "retry", "image-preflight", "image-apply", "image-inspect", "image-retry"],
      availability: "runtime-platform-and-target-preflight-required",
    });
    assert.deepEqual(manifest.authority, {
      kind: "bounded-operational-process-and-file-effects",
      instructionAuthority: false,
      promotionAuthority: false,
      recoveryAuthority: false,
      grantsExecutionAuthorization: false,
      grantsWriteAuthorization: false,
      mutatesCanon: false,
    });
  }
  const nativeRoot = new URL("../native/lode-agent-worker/internal/", import.meta.url);
  for (const [file, constant, version] of [
    ["fileeffect/transport.go", "TransportProtocolVersion", "0.1.0"],
    ["fileeffect/image.go", "ImageProtocolVersion", "0.1.0"],
    ["processsupervisor/job.go", "JobProtocolVersion", "0.1.0"],
    ["processsupervisor/protocol.go", "ProtocolVersion", "0.1.0"],
    ["processsupervisor/protocol.go", "InteractiveProtocolVersion", "0.1.0"],
  ]) {
    const source = fs.readFileSync(new URL(file, nativeRoot), "utf8");
    assert.ok(source.includes(`const ${constant} = "${version}"`), `${constant} differs from the declared build protocol`);
  }
});

test("interactive declaration is exact and cannot imply provider authorization or weaken one-shot framing", (t) => {
  const f = fixture(t);
  for (const mutate of [
    (value) => {
      value.manifestVersion = "0.2.0";
    },
    (value) => {
      value.manifestVersion = "0.2.0";
      delete value.capabilities.processSupervision.interactiveProtocolVersion;
      delete value.capabilities.processSupervision.interactiveTransport;
    },
    (value) => {
      delete value.capabilities.processSupervision.interactiveProtocolVersion;
    },
    (value) => {
      delete value.capabilities.processSupervision.interactiveTransport;
    },
    (value) => {
      value.capabilities.processSupervision.interactiveProtocolVersion = "99.0.0";
    },
    (value) => {
      value.capabilities.processSupervision.interactiveTransport = "unbounded-streaming-stdio";
    },
    (value) => {
      value.capabilities.processSupervision.providerSessionAuthorized = true;
    },
    (value) => {
      value.processModel.transport = "bounded-bootstrap-line-streaming-stdio";
    },
  ]) {
    const value = structuredClone(f.manifest);
    mutate(value);
    assert.throws(() => verifyProcessSupervisorManifest(reidentify(value), f), { code: "INVALID_PROCESS_SUPERVISOR_MANIFEST" });
  }
});

test("a self-consistent manifest digest cannot amplify authority or conceal physical file effects", (t) => {
  const f = fixture(t);
  const mutations = [
    ...Object.keys(f.manifest.authority)
      .filter((key) => key !== "kind")
      .map((key) => (value) => {
        value.authority[key] = true;
      }),
    (value) => {
      value.authority.kind = "operational-process-control-only";
    },
    (value) => {
      value.authority.approvedBy = "caller-asserted-user";
    },
    (value) => {
      value.schemaVersion = 1;
      value.manifestVersion = "0.1.0";
      delete value.capabilities;
    },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(f.manifest);
    mutate(value);
    assert.throws(() => verifyProcessSupervisorManifest(reidentify(value), f), { code: "INVALID_PROCESS_SUPERVISOR_MANIFEST" });
  }
});

test("manifest capabilities cannot replace current platform and exact-target preflight", (t) => {
  const f = fixture(t);
  for (const mutate of [
    (value) => {
      value.capabilities.declarationOnly = false;
    },
    (value) => {
      value.capabilities.fileEffects.availability = "supported";
    },
    (value) => {
      value.capabilities.fileEffects.preflightPassed = true;
    },
    (value) => {
      value.capabilities.fileEffects.operations.push("unbounded-write");
    },
    (value) => {
      value.capabilities.fileEffects.operations = ["probe", "inspect"];
    },
    (value) => {
      value.capabilities.fileEffects.imageProtocolVersion = "99.0.0";
    },
    (value) => {
      value.capabilities.processSupervision.detachedJobAvailability = "supported-on-all-platforms";
    },
  ]) {
    const value = structuredClone(f.manifest);
    mutate(value);
    assert.throws(() => verifyProcessSupervisorManifest(reidentify(value), f), { code: "INVALID_PROCESS_SUPERVISOR_MANIFEST" });
  }
});

test("declaration verification retains exact target and installed binary integrity checks", (t) => {
  const f = fixture(t);
  const resolved = resolveVerifiedProcessSupervisor({ pluginRoot: f.root });
  assert.equal(resolved.manifest.manifestId, f.manifest.manifestId);
  assert.equal(resolved.manifest.capabilities.declarationOnly, true);
  assert.throws(() => verifyProcessSupervisorManifest(f.manifest, { platform: f.platform, arch: f.arch === "x64" ? "arm64" : "x64" }));
  fs.appendFileSync(f.binaryFile, "tamper");
  assert.throws(() => resolveVerifiedProcessSupervisor({ pluginRoot: f.root }), { code: "PROCESS_SUPERVISOR_BINARY_DIGEST_MISMATCH" });
});

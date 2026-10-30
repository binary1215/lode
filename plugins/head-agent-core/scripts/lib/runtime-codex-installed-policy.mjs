import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CODEX_WORKER_REQUIRED_ENFORCEMENT } from "./runtime-codex-worker-policy.mjs";
import { inspectCurrentCodexNativeForkCompatibility } from "./runtime-codex-fork-compatibility.mjs";

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const fail = message => { throw Object.assign(new Error(message), { code: "INVALID_CODEX_INSTALLED_POLICY_SNAPSHOT" }); };

// Explicit developer audit of retained, generated schema bytes. These hashes
// identify what was inspected; they are never an OS/tool/instruction proof.
// A different build/snapshot requires another audit, not guessed API semantics.
const auditedExecutable = "444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b";
const schemas = Object.freeze({
  "v2/CommandExecParams.json": "fd034b4c85d7b6f466e30a3cbb73db86be1263aca3f81b89b547f14817dfb62e",
  "v2/CommandExecResponse.json": "dec52d187121e8dd48124b47a4a8d8428ef3717b98b9200345bb404f73b62c9d",
  "v2/WindowsSandboxReadinessResponse.json": "077f60a3d6d1fc226c45059472b29caf675fdc3fdebb29569eaab94bd05ceb00",
  "v2/PermissionProfileListResponse.json": "4a290b5b9d47c2fc671033e22754671161bc563027ba387e861bd935398f0def",
  "v2/ThreadStartParams.json": "25f490368ec6df52a2a3b82a5469d2413307eb93439121b309f415b5648eee7a",
  "v2/ThreadStartResponse.json": "a338467af5fc271ace917f9d1262405642c3df3b66116aa105343db86cc9a76d",
  "PermissionsRequestApprovalParams.json": "c6d165e1b0c65d5dcf1e099b4c226c7e4dad79fe2b88b03621a1fc6c1d3c86c2",
  "v2/ConfigRequirementsReadResponse.json": "14ae1953f5077a5d37399aa467f6e08c74601af5fa0c4ffc703b8a2858b0cc81",
  "v2/ConfigReadResponse.json": "96a04a3f7fff2dc7fafc9f831e8bcd422e021d697dd2c14c801f098a9f21396d",
  "v2/AppsInstalledResponse.json": "d8ef8dd14dcba8aaaaaf2b0b80db90d66edf8f4ff422589b844ae2b0edcb46d4",
  "v2/ListMcpServerStatusResponse.json": "d581e9ba17f6da0d686d0e730cddd51fda091f361a8c119317b2138a3ecdb612",
  "v2/CommandExecTerminateParams.json": "979ece7059c6713d0909ab1690daec27149510f4ea2ec10014600bfb1d631c97",
  "v2/ProcessSpawnParams.json": "eee34185e44cde6355516d9347e6bde6801efd19f06887406c0b10823003fa28",
});

// Controls are real schema surfaces. Gaps describe the reviewed typed API, not
// a claim that arbitrary config fields or a future Host could never enforce it.
const obligations = [
  { id: "effective-os-sandbox", setupDependent: true,
    controls: ["v2/CommandExecParams.json#/properties/permissionProfile", "v2/CommandExecParams.json#/properties/sandboxPolicy",
      "v2/WindowsSandboxReadinessResponse.json#/definitions/WindowsSandboxReadiness"],
    gap: "Readiness does not identify the effective backend or enforced policy; command output is not complete sandbox attestation." },
  { id: "selected-input-reads", setupDependent: true,
    controls: ["PermissionsRequestApprovalParams.json#/definitions/AdditionalFileSystemPermissions",
      "v2/PermissionProfileListResponse.json#/definitions/PermissionProfileSummary"],
    gap: "Read/write/deny entries exist in thread/turn additional-permission approval. Profile listing does not return an expanded baseline read boundary." },
  { id: "exact-owned-path-writes", setupDependent: true,
    controls: ["v2/CommandExecParams.json#/definitions/SandboxPolicy/oneOf/3/properties/writableRoots",
      "v2/CommandExecParams.json#/definitions/SandboxPolicy/oneOf/3/properties/excludeSlashTmp",
      "v2/CommandExecParams.json#/definitions/SandboxPolicy/oneOf/3/properties/excludeTmpdirEnvVar"],
    gap: "Writable roots are controls, not the effective writable closure, exact owned-file confinement or canonical alias/reparse enforcement." },
  { id: "outside-root-denials", setupDependent: true,
    controls: ["PermissionsRequestApprovalParams.json#/definitions/FileSystemAccessMode",
      "PermissionsRequestApprovalParams.json#/definitions/FileSystemPath"],
    gap: "Deny is supported, but effective baseline precedence, expansion and enforcement across model-callable routes are not returned." },
  { id: "credential-store-denials", setupDependent: true,
    controls: ["v2/ConfigRequirementsReadResponse.json#/definitions/ConfigRequirements/properties/cliAuthCredentialsStore",
      "v2/CommandExecParams.json#/properties/env"],
    gap: "Credential storage choice and environment overrides do not establish model/tool denial of files, keyring, inherited secrets or credential APIs. Trusted provider authentication remains distinct." },
  { id: "provider-network-only", setupDependent: true,
    controls: ["v2/ConfigRequirementsReadResponse.json#/definitions/NetworkRequirements"],
    gap: "Network/domain requirements exist, but do not establish provider-transport versus model-callable network separation and effective per-process enforcement." },
  { id: "effective-tool-scope", setupDependent: false,
    controls: ["v2/ThreadStartParams.json#/properties/dynamicTools", "v2/ThreadStartParams.json#/properties/selectedCapabilityRoots",
      "v2/ConfigReadResponse.json#/definitions/AppToolConfig/properties/enabled",
      "v2/AppsInstalledResponse.json#/definitions/InstalledApp/properties/callable",
      "v2/ListMcpServerStatusResponse.json#/definitions/McpServerStatus/properties/tools"],
    gap: "App callable and MCP tool/status readbacks are partial effective observations, not a total built-in, dynamic, deferred and connector manifest with dispatch-denial evidence." },
  { id: "effective-instruction-scope", setupDependent: false,
    controls: ["v2/ThreadStartParams.json#/properties/baseInstructions", "v2/ThreadStartParams.json#/properties/developerInstructions",
      "v2/ThreadStartResponse.json#/properties/instructionSources", "v2/ConfigReadResponse.json#/properties/layers"],
    gap: "Instruction-source paths and config layers do not identify exact additional configured/inherited instruction bytes, precedence and effective composition. Provider baseline semantic influence is not the obligation." },
  { id: "owned-process-tree", setupDependent: false,
    controls: ["v2/CommandExecParams.json#/properties/processId", "v2/CommandExecParams.json#/properties/timeoutMs",
      "v2/CommandExecTerminateParams.json#/properties/processId", "v2/ProcessSpawnParams.json#/description"],
    gap: "Connection-scoped process IDs/termination are not OS descendant closure. The separate Host supervisor is required; process/spawn explicitly bypasses the Codex sandbox." },
];
if (JSON.stringify(obligations.map(item => item.id)) !== JSON.stringify(CODEX_WORKER_REQUIRED_ENFORCEMENT)) throw new Error("Installed policy audit obligations drifted.");

function readBounded(file, maxBytes, collect = true) {
  if (typeof file !== "string" || !path.isAbsolute(file)) fail("Snapshot paths must be absolute local paths.");
  if (fs.realpathSync(file) !== path.resolve(file)) fail("Snapshot path must not traverse links.");
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || before.nlink !== 1) fail("Snapshot input must be a bounded, unlinked regular file.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail("Snapshot input changed during open.");
    const digest = crypto.createHash("sha256"), chunks = [], buffer = Buffer.alloc(1024 * 1024);
    let count, total = 0;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      total += count;
      if (total > maxBytes) fail("Snapshot input exceeded its byte bound.");
      digest.update(buffer.subarray(0, count));
      if (collect) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (opened.size !== total || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
      || named.dev !== opened.dev || named.ino !== opened.ino || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs) fail("Snapshot input changed while reading.");
    return { digest: digest.digest("hex"), size: total, bytes: collect ? Buffer.concat(chunks) : null };
  } finally { fs.closeSync(fd); }
}

function observedReadiness(value, executableDigest) {
  if (value === undefined) return { status: "not-probed", enforcementEvidence: false };
  if (!value || Object.keys(value).sort().join() !== "executableDigest,observedAt,status"
    || !["ready", "notConfigured", "updateRequired"].includes(value.status)
    || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))
    || !/^[a-f0-9]{64}$/.test(value.executableDigest || "")) fail("Invalid retained Windows readiness observation.");
  return { status: value.executableDigest !== executableDigest ? "unbound-observation"
    : value.status === "ready" ? "ready-observed-not-enforced" : "setupRequired",
  observation: { ...value }, source: "caller-supplied-retained-observation-not-current-state", enforcementEvidence: false };
}

// Optional, read-only developer preflight. No spawn, RPC, schema generation,
// config/account reads, setup, authorization consumption or capability factory.
// This result cannot be passed to bindCodexWorkerPolicyCapability as a Host.
export function inspectCodexInstalledPolicySnapshot({ executablePath, schemaDirectory, execHelpFile, windowsReadinessObservation } = {}) {
  if (typeof schemaDirectory !== "string" || !path.isAbsolute(schemaDirectory)
    || fs.realpathSync(schemaDirectory) !== path.resolve(schemaDirectory) || !fs.lstatSync(schemaDirectory).isDirectory()) fail("Expected an absolute local schema directory.");
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)) fail("Expected an absolute executable path.");
  // The installed bin directory is a launcher junction. Record its resolution
  // for this diagnostic, then read the bounded canonical file. This does not
  // relax the separate runtime capability's exact canonical target fence.
  const canonicalExecutable = fs.realpathSync(executablePath);
  const executable = readBounded(canonicalExecutable, 512 * 1024 * 1024, false);
  const loaded = {}, files = [];
  for (const [file, expectedDigest] of Object.entries(schemas)) {
    const record = readBounded(path.join(schemaDirectory, file), 8 * 1024 * 1024);
    try { loaded[file] = JSON.parse(record.bytes.toString("utf8")); } catch { fail(`Invalid JSON schema: ${file}`); }
    if (!loaded[file] || typeof loaded[file] !== "object" || Array.isArray(loaded[file])) fail(`Invalid JSON schema object: ${file}`);
    files.push({ file, digest: record.digest, size: record.size, matchesAuditedSnapshot: record.digest === expectedDigest });
  }
  const recognized = executable.digest === auditedExecutable && files.every(file => file.matchesAuditedSnapshot);
  const rows = obligations.map(item => ({ ...item,
    controls: item.controls.map(reference => {
      const [file, pointer] = reference.split("#");
      const present = pointer.slice(1).split("/").reduce((node, key) => node?.[key], loaded[file]) !== undefined;
      return { reference, present };
    }),
    apiObservation: recognized ? "not-established-by-installed-api" : "requires-new-snapshot-audit",
    osSetupAloneSufficient: false, enforcementVerified: false,
  }));
  const help = execHelpFile === undefined ? null : readBounded(execHelpFile, 1024 * 1024);
  const helpText = help?.bytes.toString("utf8") || "";
  return freeze({ kind: "CodexInstalledPolicyDiagnostic", protocolVersion: "0.1.0", diagnosticOnly: true,
    enforcementAvailable: false, backendStatus: "missing-backend", capabilityIssued: false, actualProviderInvoked: false,
    audit: { version: "codex-cli 0.153.4", status: recognized ? "recognized-retained-schema-snapshot" : "requires-new-snapshot-audit",
      claim: "typed-schema-observations-not-runtime-enforcement", files },
    executable: { pathDigest: hash(canonicalExecutable), requestedPathDigest: hash(path.resolve(executablePath)),
      pathWasResolved: canonicalExecutable !== path.resolve(executablePath), contentDigest: executable.digest, size: executable.size,
      matchesAuditedBuild: executable.digest === auditedExecutable },
    setup: observedReadiness(windowsReadinessObservation, executable.digest), obligations: rows,
    nativeFork: recognized ? inspectCurrentCodexNativeForkCompatibility() : { diagnosticOnly: true, status: "requires-new-snapshot-audit", capabilityIssued: false },
    execHelp: help ? { digest: help.digest, source: "retained-help-not-runtime-proof",
      ignoreUserConfigDocumented: /--ignore-user-config\b/u.test(helpText), ignoreRulesDocumented: /--ignore-rules\b/u.test(helpText) } : null,
    nextStep: "Implement and independently verify an exact Host enforcement backend; do not treat schema/config/readiness echoes or this diagnostic as a capability.",
  });
}

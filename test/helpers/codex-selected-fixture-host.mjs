// TEST ONLY: this module implements a synthetic protocol transport. It cannot
// issue actual-provider proof. Native supervisor evidence describes the Node
// fixture's ownership; no Codex provider or effective sandbox is tested here.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCodexWorkerPolicyHost } from "../../scripts/lib/runtime/runtime-codex-worker-policy.mjs";

export async function connectCodexWorkerHost({ root, executionRoot, authorization, policy }) {
  assert.equal(policy.evidenceMode, "protocol-fixture");
  const directory = path.dirname(root);
  const configuration = JSON.parse(fs.readFileSync(path.join(directory, "fixture-connection.json"), "utf8"));
  const storage = configuration.storage;
  assert.equal(storage.projectRoot, fs.realpathSync(root));
  assert.equal(storage.projectId, authorization.projectId);
  assert.equal(storage.directory, ".lode");
  const policyHost = createCodexWorkerPolicyHost({ evidenceMode: "protocol-fixture", withVerifiedPolicy: async request => {
    assert.equal(request.authorization.authorizationHash, authorization.authorizationHash);
    assert.equal(request.executionRoot, executionRoot);
    assert.equal(request.policy.enforcementVerified, false);
    assert.equal(request.evidenceMode, "protocol-fixture");
    await request.commit();
  } });
  const spawnImplementation = (command, args, options) => {
    const child = spawn(command, args, options);
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = (bytes, callback) => {
      const request = JSON.parse(bytes);
      assert.equal(request.arguments[0], "exec");
      assert.equal(request.arguments.at(-1), "-");
      assert.equal(request.workingDirectory, executionRoot);
      assert.equal(request.arguments[request.arguments.indexOf("--cd") + 1], executionRoot);
      assert.equal(request.arguments[request.arguments.indexOf("--model") + 1], policy.wireModel);
      assert.ok(request.arguments.includes("--ignore-user-config"));
      assert.ok(request.arguments.includes("--ignore-rules"));
      assert.equal(request.executable, configuration.executable);
      const schemaPath = request.arguments[request.arguments.indexOf("--output-schema") + 1];
      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      if (authorization.scope.kind === "session") {
        assert.deepEqual(schema.properties.planDelta.enum, [""]);
        assert.equal(schema.properties.impactRadius.maxItems, 0);
      }
      fs.writeFileSync(path.join(directory, "assembled-request.json"), JSON.stringify(request), { flag: "wx" });
      // Replace only in the fixture transport after recording the actual adapter
      // request. All selected input bytes and native ownership controls survive.
      request.executable = process.execPath;
      request.arguments = [path.resolve(import.meta.dirname, "codex-selected-provider-fixture.mjs"), configuration.mode];
      return end(Buffer.from(JSON.stringify(request)), callback);
    };
    return child;
  };
  const close = async () => {
    fs.writeFileSync(path.join(directory, "fixture-connection-closed.json"), JSON.stringify({
      leaseFilesPresent: fs.existsSync(path.join(root, storage.directory, "runtime", "invocations", authorization.authorizationId)),
      actualProviderInvoked: false,
    }), { flag: "wx" });
    if (configuration.closeError) throw Object.assign(new Error("Synthetic close failure"), { code: "SYNTHETIC_CLOSE_FAILURE" });
  };
  return { close, policyHost: configuration.invalidHost ? null : policyHost,
    execution: configuration.missingExecution ? null : { protocolEvidence: configuration.protocolEvidence,
    projectBinding: configuration.projectBinding, supervisorSelection: configuration.supervisorSelection,
    targetResolver: () => {
      if (configuration.resolverError) throw Object.assign(new Error("Synthetic resolver failure"), { code: "SYNTHETIC_RESOLVER_FAILURE" });
      return { executablePath: configuration.executable,
        observation: configuration.protocolEvidence.observations.find(entry => entry.runtime === "codex").executable };
    },
    spawnImplementation } };
}

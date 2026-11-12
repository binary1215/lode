// Trusted test Host runner. It executes only the local Node protocol fixture.
import path from "node:path";
import { executeBoundedWorkerDispatch } from "../../scripts/lib/worker/bounded-worker-dispatch.mjs";

export default async function ({ root, authorization, policy, signal, onProcess }) {
  if (policy.kind !== "protocol-fixture" || policy.actualProviderInvoked !== false) throw new Error("Fixture Host only");
  const providerFile = path.join(import.meta.dirname, "connected-provider-fixture.mjs");
  const args = [providerFile, policy.barrierDirectory, authorization.workerInput.taskKey,
    authorization.authorizationId, authorization.runtimeSelection.model];
  onProcess({ type: "planned", command: process.execPath, args, cwd: root, parentPid: process.pid, ports: [] });
  return executeBoundedWorkerDispatch({ root, authorizationId: authorization.authorizationId, role: authorization.workerInput.role,
    execution: { signal, protocolEvidence: policy.protocolEvidence, projectBinding: policy.projectBinding,
      supervisorSelection: policy.supervisorSelection, evidenceMode: "protocol-fixture", onProcessEvent: onProcess,
      targetResolver: () => ({ executablePath: process.execPath,
        observation: policy.protocolEvidence.observations.find(item => item.runtime === "codex").executable }),
      providerArguments: args } });
}

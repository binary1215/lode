import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  enqueueWorkerAdmission,
  openWorkerAdmissionHost,
} from "../../scripts/lib/worker/worker-admission.mjs";
import { readBoundedWorkerDispatch } from "../../scripts/lib/worker/bounded-worker-dispatch.mjs";
import {
  buildRuntimeInvocationLifecycleReceipt,
  buildRuntimeResultPacketDraft,
  readRuntimeInvocationAuthorization,
} from "../../scripts/lib/runtime/runtime-invocation-lifecycle.mjs";
import { persistRuntimeInvocationRecord } from "../../scripts/lib/runtime/runtime-invocation-record.mjs";
import { withRuntimeExecutionLease } from "../../scripts/lib/runtime/runtime-execution-lease.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const config = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), "utf8"));
process.stdout.write(`${JSON.stringify({ event: "owned-worker-admission-contender", pid: process.pid, parentPid: process.ppid, command: process.execPath, cwd: process.cwd(), ports: [] })}\n`);

const host = openWorkerAdmissionHost({
  operationalStateRoot: config.admissionOperationalRoot,
  hostExpectationRoot: config.hostExpectationRoot,
  admissionDomainId: config.admissionDomainId,
  expectedDomainInstanceId: config.domainInstanceId,
  expectedMetadataHash: config.metadataHash,
  preStartValidate: async () => ({ status: "current" }),
});
const { authorization } = readRuntimeInvocationAuthorization({ root: config.root, authorizationId: config.authorizationId });
const { dispatch } = readBoundedWorkerDispatch({ root: config.root, authorizationId: config.authorizationId });
const reservation = await enqueueWorkerAdmission({
  host,
  root: config.root,
  authorizationId: authorization.authorizationId,
  dispatchId: dispatch.dispatchId,
  mode: "detached",
});
fs.writeFileSync(config.reservedMarker, `${reservation.requestId}\n`, { flag: "wx" });
const ownerFenceDigest = hash(`worker-admission-contender/${process.pid}/${authorization.authorizationId}`);
const leased = await withRuntimeExecutionLease({
  projectRoot: config.root,
  authorization,
  ownerFenceDigest,
}, async ({ consumption }) => {
  fs.writeFileSync(config.startedMarker, `${process.pid}\n`, { flag: "wx" });
  while (!fs.existsSync(config.releaseMarker)) await new Promise((resolve) => setTimeout(resolve, 10));
  return {
    receipt: buildRuntimeInvocationLifecycleReceipt({
      authorization,
      events: [],
      consumption,
      status: "completed",
      exitCode: 0,
      signal: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutDigest: hash(""),
      stderrDigest: hash(""),
      callerFenceDigest: ownerFenceDigest,
      childFenceDigest: hash(`worker-admission-contender-child/${authorization.authorizationId}`),
      childStarted: false,
      childExitObserved: false,
      terminationRequested: false,
      projectFenceValidated: true,
      inputDigestObserved: authorization.executionInput.digest,
      noDescendantFixture: true,
      descendantTreeOwnershipValidated: false,
      providerMode: `${authorization.runtime}-protocol-fixture`,
    }),
  };
}, { preConsumeGate: reservation.preConsumeGate });
const draft = buildRuntimeResultPacketDraft({ authorization, receipt: leased.result.receipt, leaseRelease: leased.release });
persistRuntimeInvocationRecord({ projectRoot: config.root, authorization, events: [], receipt: leased.result.receipt, draft });
await reservation.finalize({ outcomeCode: "completed" });
process.stdout.write(`${JSON.stringify({ event: "owned-worker-admission-contender-complete", pid: process.pid, parentPid: process.ppid, ports: [] })}\n`);

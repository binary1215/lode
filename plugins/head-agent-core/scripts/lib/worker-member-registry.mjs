import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v;
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const fail = (message) => { throw Object.assign(new Error(message), { code: "WORKER_MEMBER_AUTHORIZATION_CONFLICT" }); };

export function workerMemberKey(authorization) {
  return hash({ projectId: authorization.projectId, [(originalFormat(authorization) || formatForVerifiedOwner()).sessionIdField]: sessionIdOf(authorization),
    runId: authorization.scope.runId, taskKey: authorization.workerInput.taskKey });
}

export function workerMemberFile(root, authorization, previous = null) {
  if (previous !== null && !/^execution-authorization-[a-f0-9]{24}$/.test(previous)) fail("Invalid prior worker attempt.");
  return path.join(root, (originalFormat(authorization) || formatForVerifiedOwner()).directory, "runtime", "worker-members", `${workerMemberKey(authorization)}${previous ? `--${previous}` : ""}.json`);
}

export function readWorkerMemberChain(root, authorization) {
  const key = workerMemberKey(authorization);
  const records = [];
  let previous = null;
  for (;;) {
    const file = workerMemberFile(root, authorization, previous);
    if (!fs.existsSync(file)) return records;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !fs.realpathSync(file).startsWith(`${fs.realpathSync(root)}${path.sep}`)) fail("Unsafe worker member record.");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const { authorizationId, authorizationHash, ...payload } = record;
    if (authorizationHash !== hash(payload) || authorizationId !== `execution-authorization-${authorizationHash.slice(0, 24)}`
      || !record.workerInput || workerMemberKey(record) !== key
      || record.workerInput.previousAuthorizationId !== previous || records.some((item) => item.authorizationId === authorizationId)) {
      fail("Worker attempt chain identity is invalid.");
    }
    records.push(record);
    previous = authorizationId;
  }
}

export function requireCurrentWorkerMember(root, authorization) {
  if (!authorization.workerInput) return;
  const current = readWorkerMemberChain(root, authorization).at(-1);
  if (!current || current.authorizationHash !== authorization.authorizationHash) fail("Worker authorization was superseded or is not published.");
}

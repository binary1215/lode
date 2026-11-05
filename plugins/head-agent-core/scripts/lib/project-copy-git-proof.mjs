import fs from "node:fs";
import crypto from "node:crypto";
import { copiedProjectFile, verifyCopiedProjectFile } from "./project-copy-evidence.mjs";

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
function original(root, admission, relative, maximum) {
  const entry = admission?.inventory.files.find((item) => item.path === relative);
  if (!entry) return null;
  if (entry.bytes > maximum) fail("SNAPSHOT_GIT_INVENTORY_LIMIT");
  verifyCopiedProjectFile(root, entry);
  const bytes = fs.readFileSync(copiedProjectFile(root, relative));
  if (bytes.length !== entry.bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256) fail("PROJECT_COPY_SOURCE_CHANGED");
  // The streamed verifier is repeated after this small bounded decode read.
  verifyCopiedProjectFile(root, entry);
  return bytes;
}
// Raw owner evidence is scoped to this copied private store. It never admits
// its old root for any other record, write, ref update, list or GC operation.
export function verifyCopiedGitOwner({ root, directory, projectId, dialect, admission, owner }) {
  if (
    !admission ||
    !owner ||
    owner.schemaVersion !== 1 ||
    owner.kind !== "LocalDerivedSnapshotStore" ||
    owner.projectId !== projectId ||
    owner.dialect !== dialect ||
    owner.objectFormat !== "sha256" ||
    owner.authority !== "derived-evidence-only" ||
    typeof owner.rootDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(owner.rootDigest)
  )
    return false;
  const base = directory + "/snapshot-objects.git/";
  const bytes = original(root, admission, base + "lode-owner.json", 4096);
  if (!bytes || JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(owner)) return false;
  // Git can only use the admitted, separately allowlisted local configuration.
  if (!original(root, admission, base + "config", 16384)) return false;
  return true;
}
export function verifyCopiedGitRef({
  root,
  directory,
  projectId,
  dialect,
  admission,
  owner,
  snapshotId,
  treeObjectId,
}) {
  if (
    !/^(?:world-model|graph-snapshot)-[a-f0-9]{24}$/.test(snapshotId || "") ||
    (treeObjectId !== null && !/^[a-f0-9]{64}$/.test(treeObjectId || "")) ||
    !verifyCopiedGitOwner({ root, directory, projectId, dialect, admission, owner })
  )
    return false;
  const base = directory + "/snapshot-objects.git/",
    ref = "refs/lode-snapshots/" + snapshotId;
  const loose = original(root, admission, base + ref, 256);
  if (loose) {
    const oid=loose.toString("ascii").trim();
    return /^[a-f0-9]{64}$/.test(oid) && (treeObjectId === null || oid === treeObjectId);
  }
  const packed = original(root, admission, base + "packed-refs", 16 * 1024 * 1024);
  if (!packed) return false;
  const matches = packed
    .toString("ascii")
    .split(/\r?\n/)
    .filter((line) => line.endsWith(" " + ref));
  return matches.length === 1 && /^[a-f0-9]{64} /.test(matches[0])
    && (treeObjectId === null || matches[0] === treeObjectId + " " + ref);
}

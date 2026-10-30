import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

function sourceFile(projectRoot, reference) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const file = path.resolve(root, ...reference.split("/"));
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { state: "not-assessed", reason: "path-outside-project" };
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return { state: "not-assessed", reason: "symlink-path-not-read" };
  }
  if (!fs.existsSync(file)) return { state: "missing", reason: "source-not-found" };
  const stat = fs.statSync(file);
  if (!stat.isFile()) return { state: "not-assessed", reason: "source-not-regular-file" };
  if (stat.size > MAX_SOURCE_BYTES) return { state: "not-assessed", reason: "source-exceeds-bounded-read-limit" };
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally { fs.closeSync(descriptor); }
  return { state: "read", digest: hash.digest("hex") };
}

export function inspectProductPolicyEvidenceCurrentness({ projectRoot, candidate } = {}) {
  const items = (candidate?.evidenceAnchors || []).map((anchor) => {
    if (anchor.kind !== "source") return {
      kind: anchor.kind,
      reference: anchor.reference,
      proposedDigest: anchor.digest,
      currentDigest: null,
      state: "not-assessed",
      reason: "external-evidence-requires-provider-or-human-review",
    };
    try {
      const current = sourceFile(projectRoot, anchor.reference);
      if (current.state !== "read") return {
        kind: anchor.kind,
        reference: anchor.reference,
        proposedDigest: anchor.digest,
        currentDigest: null,
        state: current.state,
        reason: current.reason,
      };
      const state = current.digest === anchor.digest ? "unchanged" : "changed";
      return {
        kind: anchor.kind,
        reference: anchor.reference,
        proposedDigest: anchor.digest,
        currentDigest: current.digest,
        state,
        reason: state === "unchanged" ? "exact-byte-digest-matches-proposal" : "exact-byte-digest-differs-from-proposal",
      };
    } catch {
      return {
        kind: anchor.kind,
        reference: anchor.reference,
        proposedDigest: anchor.digest,
        currentDigest: null,
        state: "not-assessed",
        reason: "bounded-source-read-failed",
      };
    }
  });
  const counts = Object.fromEntries(["unchanged", "changed", "missing", "not-assessed"].map((state) => [state, items.filter((item) => item.state === state).length]));
  const byteFreshness = counts.changed || counts.missing ? "changed-or-missing"
    : !items.length || counts["not-assessed"] === items.length ? "not-assessed"
      : counts["not-assessed"] ? "partially-assessed" : "unchanged";
  return {
    kind: "ProductPolicyEvidenceCurrentnessProjection",
    candidateId: candidate?.candidateId || null,
    byteFreshness,
    semanticReassessment: "not-assessed",
    counts,
    items,
    authority: "P4-read-only-diagnostic",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
    canonMutated: false,
    automaticReviewRequired: false,
    ordinaryWorkBlocked: false,
  };
}

import fs from "node:fs";
import path from "node:path";
import { safeSnapshotPath } from "./snapshot-storage-codec.mjs";
const backend = (relative) =>
  /^(world-model|graph-projection)\/snapshots\//.test(relative)
    ? "snapshotFiles"
    : relative.startsWith("snapshot-bundles/")
      ? "domainBundles"
      : relative.startsWith("snapshot-objects.git/")
        ? "privateGitFiles"
        : relative.startsWith("observations/source-bundles/")
          ? "sourceBundles"
          : "otherProjectFiles";
export function summarizeObservedStorageFiles(rows, { complete = false, issues = [], omittedIssues = 0, scope = "observed-local-files" } = {}) {
  const backends = Object.fromEntries(
    ["snapshotFiles", "domainBundles", "privateGitFiles", "sourceBundles", "otherProjectFiles"].map((key) => [key, { files: 0, observedFileBytes: 0 }]),
  );
  for (const row of rows) {
    const item = backends[backend(row.relative)];
    item.files++;
    item.observedFileBytes += row.bytes;
  }
  return {
    kind: "PhysicalStorageObservation",
    scope,
    observedFileBytes: Object.values(backends).reduce((sum, item) => sum + item.observedFileBytes, 0),
    backends,
    coverage: { complete, issues: issues.slice(0, 100), omittedIssues: omittedIssues + Math.max(0, issues.length - 100) },
    meaning: "Observed regular-file lengths, not allocated disk blocks or safe reclaimable bytes; non-atomic observation.",
    deletionAuthority: false,
  };
}
// Count physical lengths without decoding or validating evidence. This view
// never feeds deletion closure, readiness, permissions, or safe-reclaim claims.
export function inspectPhysicalStorage({ root, storage, maxEntries = 50_000, maxBytes = 1024 ** 3, relativePaths = [""] }) {
  const base = path.join(root, storage.directory),
    rows = [],
    issues = [];
  let entries = 0,
    bytes = 0,
    stopped = false;
  function walk(relative = "") {
    if (stopped) return;
    if (++entries > maxEntries) {
      stopped = true;
      issues.push({ path: relative, reasonCode: "PHYSICAL_OBSERVATION_LIMIT" });
      return;
    }
    if (relative === ".operations" || relative === ".snapshot-gc" || /^refresh\/writer\.lock(?:\.|\/|$)/.test(relative)) {
      issues.push({ path: relative, reasonCode: "TRANSIENT_COORDINATION_EXCLUDED" });
      return;
    }
    try {
      const file = safeSnapshotPath(root, path.join(base, relative)),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
        issues.push({ path: relative, reasonCode: "UNSAFE_PHYSICAL_ENTRY_EXCLUDED" });
        return;
      }
      if (stat.isDirectory()) {
        const directory = fs.opendirSync(file);
        try {
          let entry;
          while (!stopped && (entry = directory.readSync())) walk(relative ? relative + "/" + entry.name : entry.name);
        } finally {
          directory.closeSync();
        }
      } else if (bytes + stat.size > maxBytes) {
        stopped = true;
        issues.push({ path: relative, reasonCode: "PHYSICAL_OBSERVATION_BYTE_LIMIT" });
      } else {
        bytes += stat.size;
        rows.push({ relative, bytes: stat.size });
      }
    } catch (error) {
      issues.push({ path: relative, reasonCode: error.code || "PHYSICAL_ENTRY_UNAVAILABLE" });
    }
  }
  for (const relative of relativePaths) walk(relative);
  return summarizeObservedStorageFiles(rows, { complete: !stopped && !issues.length, issues });
}

export function mergePhysicalStorageObservations(observations) {
  const merged = summarizeObservedStorageFiles([], { complete: true });
  for (const observation of observations) {
    merged.observedFileBytes += observation.observedFileBytes;
    for (const [key, row] of Object.entries(observation.backends)) {
      merged.backends[key].files += row.files;
      merged.backends[key].observedFileBytes += row.observedFileBytes;
    }
    merged.coverage.complete &&= observation.coverage.complete;
    merged.coverage.issues.push(...observation.coverage.issues);
    merged.coverage.omittedIssues += observation.coverage.omittedIssues;
  }
  merged.coverage.omittedIssues += Math.max(0, merged.coverage.issues.length - 100);
  merged.coverage.issues = merged.coverage.issues.slice(0, 100);
  return merged;
}

import { applyHistoricalArtifactBoundary } from "../../../scripts/lib/world/historical-artifact-boundary.mjs";
import { readHistoricalBoundaryApplication } from "../../../scripts/lib/world/historical-artifact-boundary-store.mjs";
import { inspectProject } from "../../../scripts/lib/head-core.mjs";
import { inspectLegacyOnboarding } from "./legacy-validator.mjs";

function completedApplication(root) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") return null;
  return readHistoricalBoundaryApplication({
    root: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
    allowAbsent: true,
    verifyBytes: true,
  });
}

function completedCandidateProtocol(application) {
  return application.boundary.entries.find((entry) => entry.role === "historical-candidate-set")?.protocolVersion || null;
}

export function inspectMigration(options = {}) {
  const completed = completedApplication(options.root ?? ".");
  if (completed?.commit)
    return {
      status: "already-applied",
      writes: 0,
      boundaryId: completed.boundary.boundaryId,
      boundaryHash: completed.boundary.boundaryHash,
      coverage: completed.coverage,
    };
  const inspected = inspectLegacyOnboarding(options);
  const { capability, ...projection } = inspected;
  return projection;
}

export function applyMigration(options = {}) {
  const completed = completedApplication(options.root ?? ".");
  if (completed?.commit)
    return {
      status: "already-applied",
      writes: 0,
      boundary: completed.boundary,
      receipt: completed.receipt,
      commit: completed.commit,
      coverage: completed.coverage,
      migration: {
        candidateProtocolVersion: completedCandidateProtocol(completed),
        source: "standalone-pinned-one-shot",
        instructionAuthority: false,
        promotionAuthority: false,
      },
    };
  const inspected = inspectLegacyOnboarding(options);
  const result = applyHistoricalArtifactBoundary({ root: inspected.projectRoot, verifiedInventory: inspected.capability, hostMode: "explicit-one-shot" });
  return {
    ...result,
    migration: {
      candidateProtocolVersion: inspected.candidateProtocolVersion,
      source: "standalone-pinned-one-shot",
      instructionAuthority: false,
      promotionAuthority: false,
    },
  };
}

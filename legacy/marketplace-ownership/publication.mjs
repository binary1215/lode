import fs from "node:fs";
import path from "node:path";
import { readPublicationSnapshot } from "../../scripts/lib/publication-version.mjs";
import { verifyHistoricalMarketplaceOwnership } from "./verify.mjs";

const renamePins = { codex: "d0b9b6bee9e6aaed5c76de1c881520067d61e985", claude: "d22c0e04a8bcaf83814f452fb69ae99a13de8f0a" };
export function previousPublicationRepository({ provider, repository, marketplaceName, snapshotCommit }) {
  if (
    !["codex", "claude"].includes(provider) ||
    marketplaceName !== "head-agent-plugin" ||
    !["binary1215/lode", "binary1215/head-agent-plugin"].includes(repository) ||
    !/^[a-f0-9]{40}$/.test(snapshotCommit || "")
  ) {
    throw new Error("Historical publication lookup requires exact existing HEAD ownership scope.");
  }
  return repository === "binary1215/lode" && snapshotCommit === renamePins[provider] ? "binary1215/head-agent-plugin" : repository;
}

// Reuse the existing ownership rules; this is not a candidate/install/runtime reader.
export function readPreviousPublication(args) {
  const repository = previousPublicationRepository(args);
  try {
    const result = readPublicationSnapshot({
      ...args,
      repository,
      allowLegacyBytePreservation: args.provider === "codex",
      allowLegacyInterfaceForOwnership: args.provider === "codex",
    });
    return { ...result, previousSourceRepository: result.sourceRepository, sourceRepository: args.repository };
  } catch (error) {
    // The older native schema has its own exact commit + whole-tree digest verifier.
    verifyHistoricalMarketplaceOwnership({
      root: args.root,
      provider: args.provider,
      expectedRepository: "binary1215/head-agent-plugin",
      expectedMarketplaceName: args.marketplaceName,
      expectedSnapshotCommit: args.snapshotCommit,
    });
    const marker = JSON.parse(
      fs.readFileSync(
        path.join(args.root, args.provider === "codex" ? ".head-agent-marketplace-generated.json" : ".head-agent-claude-marketplace-generated.json"),
        "utf8",
      ),
    );
    return {
      provider: args.provider,
      marketplaceName: marker.marketplaceName,
      pluginName: marker.pluginName,
      pluginVersion: marker.pluginVersion,
      sourceCommit: marker.sourceCommit,
      sourceRepository: args.repository,
      previousSourceRepository: marker.sourceRepository,
      files: null,
      nativeTargetCount: 5,
    };
  }
}

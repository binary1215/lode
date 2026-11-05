import { resolveOperation } from "./lode-operation-contract.mjs";

// Build-owned literal. Carrier staging fixes this before manifest hashes are
// computed; it is not a runtime option, environment variable or Project mode.
const ARTIFACT_IDENTITY = "head";
const compositions = Object.freeze({
  lode: Object.freeze({ identity: "lode", toolPrefix: "lode_", serverName: "lode",
    packageName: "@local/lode-agent-core-plugin", pluginName: "lode-agent-core", marketplaceName: "lode-agent-plugin", cliEntry: "scripts/lode.mjs",
    skills: Object.freeze({ core: "lode-agent-core", onboarding: "lode-agent-onboarding", conversation: "lode-conversation" }) }),
  head: Object.freeze({ identity: "head", toolPrefix: "head_", serverName: "lode",
    packageName: "@local/head-agent-core-plugin", pluginName: "head-agent-core", marketplaceName: "head-agent-plugin", cliEntry: "scripts/head.mjs",
    skills: Object.freeze({ core: "head-agent-core", onboarding: "head-agent-onboarding", conversation: "head-conversation" }) }),
});
export function artifactCompositionForIdentity(identity) {
  const value = Object.hasOwn(compositions, identity) ? compositions[identity] : null;
  if (!value) throw new Error("Unknown package artifact composition.");
  return value;
}
export const ARTIFACT_COMPOSITION = artifactCompositionForIdentity(ARTIFACT_IDENTITY);
export function publicToolName(name) {
  const operation = resolveOperation(name);
  return operation ? ARTIFACT_COMPOSITION.identity === "lode" ? operation.canonicalName : operation.legacyName : name;
}

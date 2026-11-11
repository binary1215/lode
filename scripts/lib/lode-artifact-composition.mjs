import { resolveOperation } from "./lode-operation-contract.mjs";
import { groupMembership, operationGroup } from "./operation-groups.mjs";
import { legacyOperationName } from "../../compat/head/public-names.mjs";

// Build-owned literal. Carrier staging fixes this before manifest hashes are
// computed; it is not a runtime option, environment variable or Project mode.
const ARTIFACT_IDENTITY = "lode";
const compositions = Object.freeze({
  lode: Object.freeze({
    identity: "lode",
    toolPrefix: "lode_",
    serverName: "lode",
    packageName: "@local/lode-agent-core-plugin",
    pluginName: "lode-agent-core",
    marketplaceName: "lode-agent-plugin",
    cliEntry: "scripts/lode.mjs",
    skills: Object.freeze({ core: "lode-agent-core", onboarding: "lode-agent-onboarding", conversation: "lode-conversation" }),
  }),
  head: Object.freeze({
    identity: "head",
    toolPrefix: "head_",
    serverName: "lode",
    packageName: "@local/head-agent-core-plugin",
    pluginName: "head-agent-core",
    marketplaceName: "head-agent-plugin",
    cliEntry: "scripts/head.mjs",
    skills: Object.freeze({ core: "head-agent-core", onboarding: "head-agent-onboarding", conversation: "head-conversation" }),
  }),
});
export function artifactCompositionForIdentity(identity) {
  const value = Object.hasOwn(compositions, identity) ? compositions[identity] : null;
  if (!value) throw new Error("Unknown package artifact composition.");
  return value;
}
export const ARTIFACT_COMPOSITION = artifactCompositionForIdentity(ARTIFACT_IDENTITY);
export function publicToolName(name) {
  const operation = resolveOperation(name);
  if (operation) return ARTIFACT_COMPOSITION.identity === "lode" ? operation.canonicalName : operation.legacyName;
  // A grouped tool (scripts/lib/operation-groups.mjs) follows the same spelling rule.
  const group = operationGroup(name);
  if (group) return ARTIFACT_COMPOSITION.identity === "lode" ? group.name : legacyOperationName(group.name);
  return name;
}

// The callable form of one operation for a hint: its grouped tool with
// `action` first in the arguments, or the operation itself when it is not
// grouped. Hints use this instead of a deprecated alias name (stage 3-F); the
// group and action come from scripts/lib/operation-groups.mjs.
export function publicHintCall(operationName, args = {}) {
  const operation = resolveOperation(operationName);
  if (!operation) throw new Error(`Unknown hint operation: ${operationName}`);
  const membership = groupMembership(operation.canonicalName);
  if (membership && Object.hasOwn(args, "action")) throw new Error(`Hint arguments for ${operationName} cannot carry an action.`);
  return membership
    ? { tool: publicToolName(membership.group.name), arguments: { action: membership.action, ...args } }
    : { tool: publicToolName(operation.canonicalName), arguments: { ...args } };
}

// The same call in prose: "lode_group (action: name)", or the tool name.
export function publicHintText(operationName) {
  const { tool, arguments: args } = publicHintCall(operationName);
  return args.action ? `${tool} (action: ${args.action})` : tool;
}

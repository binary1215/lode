import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { ENVIRONMENT_NAME_PAIRS } from "../compat/head/public-names.mjs";
import { serveMcp } from "./mcp-server.mjs";
import { VerifiedWorkspaceHostAdapter } from "./lib/workspace-host-coordination.mjs";
import { createWorkspaceHostExportDriver } from "./lib/workspace-host-export-driver.mjs";

const REQUIRED = [
  "HEAD_AGENT_HOST_PROJECT_ROOT",
  "HEAD_AGENT_WORKSPACE_HOST_EXPORT_ROOT",
  "HEAD_AGENT_HOST_WORKSPACE_ID",
  "HEAD_AGENT_HOST_TAB_ID",
  "HEAD_AGENT_HOST_ENDPOINT_ID",
  "HEAD_AGENT_HOST_PROCESS_PROOF",
];

const requiredEnvironment = (environment, name) => {
  const pair = ENVIRONMENT_NAME_PAIRS.find(item => item.legacy === name);
  const legacy = String(environment[name] || "").trim();
  const canonical = pair ? String(environment[pair.canonical] || "").trim() : "";
  if (legacy && canonical) {
    const comparePath = value => {
      if (!path.isAbsolute(value)) throw Object.assign(new Error("Host-export path references must be absolute."), { code: "WORKSPACE_HOST_EXPORT_ENVIRONMENT_CONFLICT" });
      let target = path.resolve(value), suffix = [];
      for (;;) {
        try { target = path.resolve(fs.realpathSync(target), ...suffix); break; }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          suffix.unshift(path.basename(target)); const parent = path.dirname(target);
          if (parent === target) throw error;
          target = parent;
        }
      }
      return target;
    };
    const identical = pair.class === "trusted-path-domain" ? comparePath(legacy) === comparePath(canonical) : legacy === canonical;
    if (!identical) throw Object.assign(new Error("Trusted host-export environment aliases disagree."), { code: "WORKSPACE_HOST_EXPORT_ENVIRONMENT_CONFLICT" });
  }
  const value = canonical || legacy;
  if (!value) {
    const error = new Error(`Required host-export environment reference ${name} is missing.`);
    error.code = "WORKSPACE_HOST_EXPORT_ENVIRONMENT_REQUIRED";
    throw error;
  }
  return value;
};

export function workspaceHostExportComposition({ environment = process.env } = {}) {
  const values = Object.fromEntries(REQUIRED.map((name) => [name, requiredEnvironment(environment, name)]));
  const projectRoot = values.HEAD_AGENT_HOST_PROJECT_ROOT;
  const caller = Object.freeze({
    workspaceId: values.HEAD_AGENT_HOST_WORKSPACE_ID,
    tabId: values.HEAD_AGENT_HOST_TAB_ID,
    endpointId: values.HEAD_AGENT_HOST_ENDPOINT_ID,
  });
  return Object.freeze({
    adapter: new VerifiedWorkspaceHostAdapter({
      driver: createWorkspaceHostExportDriver({
        exportRoot: values.HEAD_AGENT_WORKSPACE_HOST_EXPORT_ROOT,
        projectRoot,
        caller,
        processProof: values.HEAD_AGENT_HOST_PROCESS_PROOF,
      }),
    }),
    caller,
    projectRoot,
    source: "trusted-host-export-environment",
    providerSessionIdentityPersisted: false,
  });
}

export function serveWorkspaceHostExportMcp({ environment = process.env } = {}) {
  return serveMcp({ coordinationWorkspaceHost: workspaceHostExportComposition({ environment }) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) serveWorkspaceHostExportMcp();

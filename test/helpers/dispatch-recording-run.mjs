// Records which scripts/lib function each MCP tool and CLI command calls, and with
// which arguments, with every operation implementation replaced by a recorder (no
// file effects). Run through test/helpers/dispatch-recording-register.mjs:
//
//   node --import ./test/helpers/dispatch-recording-register.mjs test/helpers/dispatch-recording-run.mjs [--out file]
//
// The output is deterministic and machine-independent: the fixture root, the
// working directory and process.env are replaced by placeholders.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skipCode } from "../../scripts/codemods/js-scan.mjs";
import { OPERATIONS } from "../../scripts/lib/operation-registry.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// An identifiable stand-in, so a recording shows where the host registry is passed on.
const OBSERVATION_REGISTRY = Object.freeze({ lodeRecordingPlaceholder: "observationRegistry" });
const GRAPHDB_TRANSPORT = Object.freeze({ lodeRecordingPlaceholder: "graphDbTransport" });
const COMPACTION_LIFECYCLE_HOST = Object.freeze({ lodeRecordingPlaceholder: "compactionLifecycleHost" });
const READ_RELATED_NATIVE_CONTEXT = Object.freeze({ lodeRecordingPlaceholder: "readRelatedNativeContext" });
export const FIXTURE_ROOT = "/lode-dispatch-fixture/project";

// Dispatch infrastructure that must run for real for a call to reach its
// implementation: name resolution, surface and argument checks, presentation.
const PASS_THROUGH = new Map([
  ["lode-operation-contract", null],
  ["managed-maintenance-surface", null],
  ["mcp-argument-validation", null],
  ["lode-artifact-composition", null],
  ["subagent-write-guard", null],
  ["lode-entry-guidance", null],
  ["context-budget", null],
  ["cli-presentation", new Set(["formatMcpToolContent"])],
  ["session-routing", new Set(["sessionCallRequiresBinding"])],
]);

const recorder = {
  active: false,
  calls: [],
  passThrough(module, name) {
    if (!PASS_THROUGH.has(module)) return false;
    const names = PASS_THROUGH.get(module);
    return names === null || names.has(name);
  },
  record(module, name, args) {
    this.calls.push({ fn: `${module}#${name}`, args });
    return undefined;
  },
};
globalThis.__lodeDispatchRecorder = recorder;

// ---- input generation -------------------------------------------------------

function sample(schema, name, full, depth = 0) {
  if (!schema || typeof schema !== "object") return `sample-${name}`;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum.find((value) => value !== null) ?? schema.enum[0];
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) return sample(alternatives.find((item) => item.type !== "null") ?? alternatives[0], name, full, depth);
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (type === "string") return `sample-${name}`;
  if (type === "integer" || type === "number") return schema.minimum ?? 1;
  if (type === "boolean") return true;
  if (type === "array") return depth > 3 ? [] : [sample(schema.items, name, full, depth + 1)];
  if (type === "object" || schema.properties) {
    if (depth > 3) return {};
    const value = {};
    const required = new Set(schema.required ?? []);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (full || required.has(key)) value[key] = sample(child, key, full, depth + 1);
    }
    return value;
  }
  return `sample-${name}`;
}

function falsy(schema) {
  const alternatives = schema?.anyOf ?? schema?.oneOf;
  const chosen = Array.isArray(alternatives) ? (alternatives.find((item) => item.type !== "null") ?? alternatives[0]) : schema;
  const type = Array.isArray(chosen?.type) ? chosen.type.find((item) => item !== "null") : chosen?.type;
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object" || chosen?.properties) return {};
  return "";
}

export function mcpInputs(tool) {
  const schema = tool.inputSchema ?? {};
  // Top-level alternatives (anyOf/oneOf of object shapes) each get their own inputs.
  const alternatives = (schema.anyOf ?? schema.oneOf ?? [{}]).filter((item) => item && typeof item === "object");
  const inputs = [];
  for (const alternative of alternatives) {
    const shape = {
      type: "object",
      properties: { ...schema.properties, ...alternative.properties },
      required: [...new Set([...(schema.required ?? []), ...(alternative.required ?? [])])],
    };
    const requiredBooleans = shape.required.filter((key) => falsy(shape.properties[key]) === false);
    for (const variant of ["required", "full", "falsy", ...(requiredBooleans.length ? ["required-false"] : [])]) {
      const input = sample(shape, tool.name, variant !== "required" && variant !== "required-false");
      // Optional fields set to their type's falsy value tell `||` from `??` defaults.
      if (variant === "falsy") {
        for (const [key, child] of Object.entries(shape.properties)) if (!shape.required.includes(key)) input[key] = falsy(child);
      }
      // Required booleans (explicit confirmations) set to false record each refusal.
      if (variant === "required-false") for (const key of requiredBooleans) input[key] = false;
      delete input.session_id;
      if (shape.properties.project_root) input.project_root = FIXTURE_ROOT;
      if (!inputs.some((existing) => JSON.stringify(existing) === JSON.stringify(input))) inputs.push(input);
    }
  }
  return inputs;
}

// CLI flags each command branch of lode.mjs reads, found statically.
export function cliCommands() {
  const src = fs.readFileSync(path.join(pluginRoot, "scripts/lode.mjs"), "utf8");
  const start = src.indexOf("async function runRoutedCommand(");
  const body = src.slice(start);
  const commands = new Map();
  const re = /if \(((?:command === "[^"]+"(?: \|\| )?)+)\)/g;
  for (let match; (match = re.exec(body)); ) {
    const names = [...match[1].matchAll(/command === "([^"]+)"/g)].map((item) => item[1]);
    let at = match.index + match[0].length;
    while (/\s/.test(body[at])) at += 1;
    const end = body[at] === "{" ? skipCode(body, at + 1, "}") : skipCode(body, at, ";");
    const block = body.slice(at, end);
    const flags = new Set();
    for (const flag of block.matchAll(/options\["([^"]+)"\]|options\.([A-Za-z_$][\w$]*)/g)) flags.add(flag[1] ?? flag[2]);
    if (/\b(?:optional)?[iI]nputJson\(options/.test(block)) flags.add("input");
    if (/evidenceNeedsInput\(options\)/.test(block)) flags.add("evidence-needs");
    for (const name of names) if (!commands.has(name)) commands.set(name, [...flags].sort());
  }
  // Commands moved to the operation registry declare the options they read.
  for (const entry of OPERATIONS) if (!commands.has(entry.cli.command)) commands.set(entry.cli.command, [...entry.cli.flags].sort());
  return commands;
}

const NUMERIC_FLAGS = /^(budget|depth|limit|offset|timeout|max-[\w-]+|min-[\w-]+|candidate-limit|iterations|wait-ms|wait-timeout-ms|edge-limit|ttl[\w-]*)$/;
const BOOLEAN_FLAGS = new Set(["details", "fresh", "scan-evidence", "inventory-page", "apply", "diagnostics", "history", "share", "write-root-instructions"]);
// Options whose non-default branch needs a specific text value.
const SAMPLE_VALUES = { "include-execution": "false", "include-candidates": "true", retain: "true" };
const isJsonFlag = (flag) => ["input", "evidence-needs"].includes(flag) || /-file$|-json$/.test(flag);

// No options; every option it reads; and, for JSON input, the same with one
// unsupported field so per-command field checks are recorded too, plus every
// other option without the JSON input so the option-built branch is recorded.
export function cliArgvs(command, flags, jsonFile, extraFieldJsonFile) {
  const argvs = [[command, FIXTURE_ROOT]];
  const withOptions = (file) => {
    const argv = [command, FIXTURE_ROOT];
    for (const flag of flags) {
      if (flag === "session") continue;
      if (BOOLEAN_FLAGS.has(flag)) argv.push(`--${flag}`, ...(["details", "scan-evidence", "inventory-page"].includes(flag) ? ["true"] : []));
      else if (isJsonFlag(flag)) {
        if (file) argv.push(`--${flag}`, file);
      }
      else argv.push(`--${flag}`, SAMPLE_VALUES[flag] ?? (NUMERIC_FLAGS.test(flag) ? "3" : `sample-${flag}`));
    }
    return argv;
  };
  if (flags.length) argvs.push(withOptions(jsonFile));
  if (flags.some(isJsonFlag)) argvs.push(withOptions(extraFieldJsonFile));
  if (flags.some(isJsonFlag) && flags.some((flag) => !isJsonFlag(flag) && flag !== "session")) argvs.push(withOptions(null));
  return argvs;
}

// ---- serialization ----------------------------------------------------------

function normalizer(workDirectory) {
  const replacements = [
    [path.resolve(FIXTURE_ROOT), "<root>"],
    [FIXTURE_ROOT, "<root>"],
    [workDirectory, "<cwd>"],
    [fs.realpathSync(workDirectory), "<cwd>"],
    [pluginRoot, "<plugin>"],
  ];
  const variants = replacements.flatMap(([from, to]) => [
    [from, to],
    [from.replaceAll("\\", "/"), to],
    [from.replaceAll("\\", "\\\\"), to],
  ]);
  variants.sort((a, b) => b[0].length - a[0].length);
  const text = (value) => {
    let out = value;
    for (const [from, to] of variants) if (from) out = out.split(from).join(to);
    return out.replace(/<(root|cwd|plugin)>((?:[\\/][^\s"'<>]*)?)/g, (whole, tag, rest) => `<${tag}>${rest.replaceAll("\\", "/")}`);
  };
  // Ancestor chain of the value being serialized: only a reference back to an
  // ancestor is circular; a value shared by two siblings is serialized twice.
  let ancestors = [];
  const replacer = function (key, value) {
    const holder = ancestors.indexOf(this);
    if (holder >= 0) ancestors = ancestors.slice(0, holder + 1);
    else ancestors = [this];
    if (value === undefined) return "$undefined";
    if (value === process.env) return "$process.env";
    if (typeof value === "function") return `$function:${value.name || "anonymous"}`;
    if (typeof value === "bigint") return `$bigint:${value}`;
    if (typeof value === "symbol") return `$symbol:${value.description}`;
    if (typeof value === "string") return text(value);
    if (value && typeof value === "object") {
      if (typeof AbortSignal !== "undefined" && value instanceof AbortSignal) return "$AbortSignal";
      if (Buffer.isBuffer(value)) return `$buffer:${value.toString("base64")}`;
      if (value instanceof Map) return { $map: [...value] };
      if (value instanceof Set) return { $set: [...value] };
      if (value instanceof Error) return { $error: value.code ?? value.name };
      const proto = Object.getPrototypeOf(value);
      if (proto && proto !== Object.prototype && proto !== Array.prototype && proto !== null) return `$instance:${proto.constructor?.name ?? "unknown"}`;
      if (ancestors.includes(value)) return "$circular";
      ancestors.push(value);
    }
    return value;
  };
  return (value) => {
    ancestors = [];
    return JSON.parse(JSON.stringify({ value }, replacer)).value;
  };
}

function outcomeOf(normalize, error, response) {
  if (error) return normalize({ error: error.code ?? error.name ?? "Error", message: error.message });
  if (response?.error) return normalize({ error: response.error.data?.reasonCode ?? response.error.code ?? "error", message: response.error.message });
  return { ok: true };
}

// ---- run --------------------------------------------------------------------

export async function recordDispatch() {
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lode-dispatch-recording-"));
  const previous = process.cwd();
  process.chdir(workDirectory);
  const jsonFile = path.join(workDirectory, "input.json");
  fs.writeFileSync(jsonFile, "{}\n");
  const extraFieldJsonFile = path.join(workDirectory, "input-extra-field.json");
  fs.writeFileSync(extraFieldJsonFile, `${JSON.stringify({ lodeRecordingUnsupportedField: true })}\n`);
  const normalize = normalizer(workDirectory);
  try {
    const mcp = await import("../../scripts/mcp-server.mjs");
    const cli = await import("../../scripts/lode.mjs");
    const { isManagedMutation } = await import("../../scripts/lib/managed-maintenance-surface.mjs");
    const entries = [];
    const capture = async (run) => {
      recorder.calls = [];
      recorder.active = true;
      let error = null,
        response = null;
      try {
        response = await run();
      } catch (caught) {
        error = caught;
      } finally {
        recorder.active = false;
      }
      return { calls: normalize(recorder.calls), outcome: outcomeOf(normalize, error, response) };
    };
    for (const tool of [...mcp.catalogTools].sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const surface = isManagedMutation(tool.name) ? "managed-maintenance" : "ordinary";
      for (const input of mcpInputs(tool)) {
        const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: input } };
        const result = await capture(() => mcp.dispatch(request, {
            surface,
            hostEnvironment: {},
            observationRegistry: OBSERVATION_REGISTRY,
            graphDbTransport: GRAPHDB_TRANSPORT,
            compactionLifecycleHost: COMPACTION_LIFECYCLE_HOST,
            readRelatedNativeContext: READ_RELATED_NATIVE_CONTEXT,
          }));
        entries.push({ surface: "mcp", tool: tool.name, input: normalize(input), ...result });
      }
    }
    const commands = cliCommands();
    for (const [command, flags] of [...commands].sort((a, b) => a[0].localeCompare(b[0], "en"))) {
      const managed = isManagedMutation(command);
      for (const argv of cliArgvs(command, flags, jsonFile, extraFieldJsonFile)) {
        const full = managed ? ["managed-maintenance", ...argv] : argv;
        const result = await capture(() => cli.runCommand(full, { observationRegistry: OBSERVATION_REGISTRY, compactionLifecycleHost: COMPACTION_LIFECYCLE_HOST }));
        entries.push({ surface: "cli", command, argv: normalize(full), ...result });
      }
    }
    return { version: 1, fixtureRoot: "<root>", entries };
  } finally {
    process.chdir(previous);
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = await recordDispatch();
  const text = `${JSON.stringify(value, null, 1)}\n`;
  const out = process.argv.indexOf("--out");
  if (out >= 0) fs.writeFileSync(process.argv[out + 1], text);
  else {
    // A piped stdout is asynchronous on POSIX: process.exit() would drop what is
    // still buffered past the first 64 KiB. Write synchronously, looping over
    // partial writes, before exiting.
    const bytes = Buffer.from(text, "utf8");
    for (let offset = 0; offset < bytes.length; ) {
      try {
        offset += fs.writeSync(process.stdout.fd, bytes, offset, bytes.length - offset);
      } catch (error) {
        if (error.code !== "EAGAIN") throw error;
      }
    }
  }
  process.exit(0);
}

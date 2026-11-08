// Module hooks for dispatch recordings. When a dispatch module (the MCP server, the
// CLI or the operation registry) imports a scripts/lib module, it receives a
// wrapper whose function exports record their calls while a recording is active
// and otherwise call the real implementation. Every other importer gets the real
// module, so library code keeps calling its own dependencies.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const libUrl = pathToFileURL(path.join(pluginRoot, "scripts/lib")).href + "/";
const DISPATCH_MODULES = new Set(
  ["scripts/mcp-server.mjs", "scripts/lode.mjs", "scripts/lib/operation-registry.mjs"].map((file) => pathToFileURL(path.join(pluginRoot, file)).href),
);
const RECORD = "lode-dispatch-record";

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const parent = context.parentURL?.split("?")[0];
  if (!parent || !DISPATCH_MODULES.has(parent)) return resolved;
  if (!resolved.url.startsWith(libUrl) || DISPATCH_MODULES.has(resolved.url) || resolved.url.startsWith(`${libUrl}core/`)) return resolved;
  return { ...resolved, url: `${resolved.url}?${RECORD}`, shortCircuit: true };
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(`?${RECORD}`)) return nextLoad(url, context);
  const real = url.slice(0, -RECORD.length - 1);
  const names = Object.keys(await import(real));
  const module = real.slice(libUrl.length).replace(/\.mjs$/, "");
  const lines = [
    `import * as real from ${JSON.stringify(real)};`,
    "const wrap = (name, value) => {",
    "  if (typeof value !== 'function' || /^class\\b/.test(Function.prototype.toString.call(value))) return value;",
    "  return function (...args) {",
    "    const recorder = globalThis.__lodeDispatchRecorder;",
    `    return recorder?.active && !recorder.passThrough(${JSON.stringify(module)}, name) ? recorder.record(${JSON.stringify(module)}, name, args) : value.apply(this, args);`,
    "  };",
    "};",
  ];
  for (const name of names) {
    if (name === "default") lines.push("export default wrap('default', real.default);");
    else lines.push(`export const ${name} = wrap(${JSON.stringify(name)}, real[${JSON.stringify(name)}]);`);
  }
  return { format: "module", source: lines.join("\n"), shortCircuit: true };
}

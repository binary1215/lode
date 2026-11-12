// Enforces the one argument every Project-scoped tool declares and no handler
// defends on its own: `project_root`. Without this, a missing root silently
// meant the server's current directory and a non-string root surfaced as a Node
// TypeError. Everything else an inputSchema declares (enumerations, patterns,
// bounds, unknown fields, confirmation flags) stays with the operation's own
// refusal: those messages explain the operation's rule, and the CLI and MCP
// paths are contracted to fail identically there.
// Returns a list of human-readable problems; empty = valid.

export function validateProjectRootArgument(schema, args, where = "arguments") {
  const declared = schema?.properties?.project_root;
  if (!declared) return [];
  const present = args && typeof args === "object" && !Array.isArray(args) && Object.hasOwn(args, "project_root") && args.project_root !== undefined;
  if (!present) {
    return (schema.required || []).includes("project_root") ? [`${where}.project_root is required`] : [];
  }
  const value = args.project_root;
  if (typeof value !== "string")
    return [`${where}.project_root must be string, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`];
  const minLength = declared.minLength ?? 1;
  if (value.length < minLength) return [`${where}.project_root must have at least ${minLength} characters`];
  return [];
}

export function assertProjectRootArgument(toolName, schema, args) {
  const problems = validateProjectRootArgument(schema, args);
  if (!problems.length) return;
  throw Object.assign(new Error(`Invalid arguments for ${toolName}: ${problems.join("; ")}.`), { code: "INVALID_TOOL_ARGUMENTS", problems });
}

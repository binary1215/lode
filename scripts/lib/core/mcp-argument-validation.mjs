// Enforces the one argument every Project-scoped tool declares and no handler
// defends on its own: `project_root`. Without this, a missing root silently
// meant the server's current directory and a non-string root surfaced as a Node
// TypeError. Everything else an inputSchema declares (enumerations, patterns,
// bounds, confirmation flags) stays with the operation's own refusal: those
// messages explain the operation's rule, and the CLI and MCP paths are
// contracted to fail identically there. Unknown fields are refused here (D2,
// below).
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

// Arguments outside a tool's declared schema are refused (user decision D2,
// 2026-11-25): before, an unknown or misspelled field was dropped silently and
// the call ran without it. The refusal names each field and, when one is
// close, the declared spelling; a field that belongs inside a declared object
// (a work-evidence field given at the top level) names that object. The two
// operations that take work evidence name the object differently; a caller
// using the other spelling is pointed at the one this tool declares.
// "_meta" is the MCP metadata key and is not a tool argument; it is ignored.
const NEAR_NAMES = Object.freeze({ work_evidence: "evidence", evidence: "work_evidence" });
const IGNORED_ARGUMENTS = new Set(["_meta"]);

export function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

// The closest of the names, when it is close enough to be a misspelling.
export function nearName(name, names) {
  let best = null;
  for (const candidate of names) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance <= Math.max(1, Math.floor(candidate.length / 4)) && (!best || distance < best.distance)) best = { candidate, distance };
  }
  return best?.candidate ?? null;
}

export function undeclaredArgumentProblems(toolName, schema, args) {
  const properties = schema?.properties;
  if (!properties || !args || typeof args !== "object" || Array.isArray(args)) return [];
  const declared = Object.keys(properties);
  const problems = [];
  for (const key of Object.keys(args)) {
    if (Object.hasOwn(properties, key) || IGNORED_ARGUMENTS.has(key)) continue;
    const named = Object.hasOwn(NEAR_NAMES, key) && Object.hasOwn(properties, NEAR_NAMES[key]) ? NEAR_NAMES[key] : null;
    const inside = declared.find((field) => properties[field]?.properties && Object.hasOwn(properties[field].properties, key));
    const near = named ?? nearName(key, declared);
    problems.push(
      `${JSON.stringify(key)} is not an argument of ${toolName}` +
        (near ? `; did you mean ${JSON.stringify(near)}?` : inside ? `; it belongs inside ${JSON.stringify(inside)}` : ""),
    );
  }
  if (problems.length) problems.push(`declared arguments: ${declared.join(", ")}`);
  return problems;
}

export function assertDeclaredArguments(toolName, schema, args) {
  const problems = undeclaredArgumentProblems(toolName, schema, args);
  if (!problems.length) return;
  throw Object.assign(new Error(`Invalid arguments for ${toolName}: ${problems.join("; ")}.`), { code: "INVALID_TOOL_ARGUMENTS", problems });
}

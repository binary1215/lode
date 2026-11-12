import fs from "node:fs";
import path from "node:path";

// On Windows a drive letter is case-insensitive, but `fs.realpathSync` keeps
// the spelling it was given, and a Project's identity (its recorded
// `projectRoot`, its id digest and the Host keys derived from it) is the exact
// spelling recorded when it was created. A requested root that differs from the
// recorded one only in drive-letter case is therefore read as the recorded
// spelling. This is a read of `project.json` only: nothing is written, no stored
// record changes, and any other difference (a moved Project, a different
// directory-name case) keeps its existing result.

const drive = /^[A-Za-z]:/;

// Two absolute Windows paths that differ only in the case of their drive letter.
export function sameExceptDriveCase(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left !== right &&
    left.length === right.length &&
    drive.test(left) &&
    drive.test(right) &&
    left[0].toLowerCase() === right[0].toLowerCase() &&
    left.slice(1) === right.slice(1)
  );
}

// The same directory on Windows when the two spellings differ at most in
// drive-letter case; exact equality everywhere else.
export function sameRootSpelling(left, right, { platform = process.platform } = {}) {
  return left === right || (platform === "win32" && sameExceptDriveCase(left, right));
}

// The recorded spelling of `root` when the Project there recorded it with only
// a different drive-letter case; otherwise `root` exactly as given.
export function recordedRootSpelling(root, { platform = process.platform } = {}) {
  if (platform !== "win32" || typeof root !== "string" || !root) return root;
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(root));
  } catch {
    return root;
  }
  if (!drive.test(resolved)) return root;
  const recorded = new Set();
  for (const directory of [".lode", ".head"]) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(resolved, directory, "project.json"), "utf8"))?.projectRoot;
      if (sameExceptDriveCase(value, resolved)) recorded.add(value);
    } catch {
      /* No readable record: the given spelling stays. */
    }
  }
  return recorded.size === 1 ? [...recorded][0] : root;
}

// An MCP tools/call request whose `project_root` (direct, routed through
// lode_tools_read/lode_tools_call, or grouped) uses the recorded spelling. The
// request is returned unchanged when nothing differs.
export function withRecordedProjectRoot(request, options) {
  const outer = request?.params?.arguments;
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) return request;
  const swap = (args) => {
    if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.project_root !== "string") return args;
    const spelled = recordedRootSpelling(args.project_root, options);
    return spelled === args.project_root ? args : { ...args, project_root: spelled };
  };
  const top = swap(outer);
  const nested = top.arguments && typeof top.arguments === "object" ? swap(top.arguments) : top.arguments;
  if (top === outer && nested === outer.arguments) return request;
  return { ...request, params: { ...request.params, arguments: nested === top.arguments ? top : { ...top, arguments: nested } } };
}

import fs from "node:fs";
import path from "node:path";

// On Windows a drive letter is case-insensitive, but `fs.realpathSync` keeps
// the spelling it was given, and a Project's identity (its recorded
// `projectRoot`, its id digest and the Host keys derived from it) is the exact
// spelling recorded when it was created. A requested root that differs from the
// recorded one only in drive-letter case is therefore read as the recorded
// spelling. This only reads the `.lode` and `.head` project.json records:
// nothing is written, no stored record changes, and any other difference (a
// moved Project, a different directory-name case) keeps its existing result.

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

// The recorded spelling of `root` when the Project there recorded it with only
// a different drive-letter case; otherwise `root` exactly as given. A record
// that already matches the given spelling keeps it, so the spelling that
// selected a Project before still selects the same one.
//
// Only a lower-case drive letter is looked up. An upper-case one (what Windows
// shells, Node and Hosts normally report) is returned without touching the
// filesystem, so argument validation still runs before any Project read. A
// Project recorded with a lower-case drive letter therefore keeps today's rule:
// it is reached with its recorded spelling.
export function recordedRootSpelling(root, { platform = process.platform } = {}) {
  if (platform !== "win32" || typeof root !== "string" || !root) return root;
  if (!/^[a-z]:/.test(path.win32.resolve(root))) return root;
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(root));
  } catch {
    return root;
  }
  if (!drive.test(resolved)) return root;
  let recorded = null;
  for (const directory of [".lode", ".head"]) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(resolved, directory, "project.json"), "utf8"))?.projectRoot;
      if (value === resolved) return root;
      if (sameExceptDriveCase(value, resolved)) recorded = value;
    } catch {
      /* No readable record: the given spelling stays. */
    }
  }
  return recorded ?? root;
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

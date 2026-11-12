import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

// On Windows a drive letter is case-insensitive, but `fs.realpathSync` keeps
// the spelling it was given, and a Project's identity (its recorded
// `projectRoot`, its id digest and the Host keys derived from it) is the exact
// spelling recorded when it was created. A requested root that differs from the
// recorded one only in drive-letter case is therefore read as the recorded
// spelling. This only reads the `.lode` and `.head` project.json records:
// nothing is written, no stored record changes, and any other difference (a
// moved Project) keeps its existing result. Directory-name case is handled
// below, only after the Project was not found.

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

// A Host hook event whose `cwd` (the root a Host hands to every hook) uses the
// recorded spelling. The event is returned unchanged when nothing differs.
export function withRecordedCwd(event, options) {
  if (!event || typeof event !== "object" || typeof event.cwd !== "string") return event;
  const cwd = recordedRootSpelling(event.cwd, options);
  return cwd === event.cwd ? event : { ...event, cwd };
}

// Directory-name case (any case-insensitive filesystem). A root whose
// directory names differ from the recorded spelling only in letter case reaches
// a Project that is not found under the given spelling: the Project marker is
// then foreign to the given spelling. Only that miss looks at the on-disk
// spelling, so a Project found as given costs no extra filesystem read. The
// entry point that received the root (MCP, CLI, Host hook, OpenCode plugin)
// runs its request inside `withOnDiskSpellingRetry`; the Project selection
// that misses stops the request before any effect, and the entry runs it once
// more with the recorded spelling. A Project whose recorded spelling is not
// its on-disk spelling (a moved or case-renamed folder) is still reported as
// it was, and nothing stored is rewritten.

const retryScope = new AsyncLocalStorage();

// Called by Project selection when the marker under `resolvedRoot` records
// `recordedRoot`. It signals a retry only inside an entry scope, only for the
// entry's own root, and only when the recorded root is the on-disk spelling of
// the same folder; otherwise it returns and the existing result stands.
export function noteRecordedSpellingMiss(resolvedRoot, recordedRoot) {
  const scope = retryScope.getStore();
  if (!scope || scope.final || typeof recordedRoot !== "string" || recordedRoot === resolvedRoot) return;
  if (!scope.recorded) {
    if (recordedRoot.toLowerCase() !== resolvedRoot.toLowerCase()) return;
    try {
      if (fs.realpathSync(path.resolve(scope.root)) !== resolvedRoot) return;
      if (fs.realpathSync.native(resolvedRoot) !== recordedRoot) return;
    } catch {
      return;
    }
    scope.recorded = recordedRoot;
  } else if (scope.recorded !== recordedRoot) return;
  throw Object.assign(new Error("The Project is recorded under another letter case of this folder; the request is retried with the recorded spelling."), {
    code: "PROJECT_ROOT_SPELLING_RETRY",
  });
}

// True inside an entry attempt whose Project selection already missed: the
// entry will run the request again, so this attempt must not deliver output
// (a hook's stdout, an OpenCode system slot) that the retry also delivers.
export function rootSpellingRetryPending() {
  const scope = retryScope.getStore();
  return Boolean(scope && !scope.final && scope.recorded);
}

// Runs `run(root)`; when its Project selection missed only because of
// directory-name case, runs `run(recordedRoot)` once more and returns that
// result. Nested entries (a bridge calling the MCP dispatcher) share the outer
// scope, so a request is retried at most once.
export async function withOnDiskSpellingRetry(root, run) {
  if (typeof root !== "string" || !root || retryScope.getStore()) return await run(root);
  const scope = { root, recorded: null, final: false };
  let first;
  try {
    first = await retryScope.run(scope, () => run(root));
  } catch (error) {
    if (!scope.recorded) throw error;
  }
  if (!scope.recorded) return first;
  return await retryScope.run({ root: scope.recorded, recorded: null, final: true }, () => run(scope.recorded));
}

// The effective `project_root` of an MCP tools/call request (the routed or
// grouped one when present), and the request with that root replaced.
export function requestProjectRoot(request) {
  const outer = request?.params?.arguments;
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) return null;
  const nested = outer.arguments && typeof outer.arguments === "object" && !Array.isArray(outer.arguments) ? outer.arguments : null;
  if (typeof nested?.project_root === "string") return nested.project_root;
  return typeof outer.project_root === "string" ? outer.project_root : null;
}

export function withRequestProjectRoot(request, from, to) {
  const outer = request.params.arguments;
  const swap = (args) => (args && typeof args === "object" && !Array.isArray(args) && args.project_root === from ? { ...args, project_root: to } : args);
  const top = swap(outer);
  const nested = top.arguments && typeof top.arguments === "object" ? swap(top.arguments) : top.arguments;
  return { ...request, params: { ...request.params, arguments: nested === top.arguments ? top : { ...top, arguments: nested } } };
}

// An MCP dispatch with the directory-name case retry around it.
export async function withRequestSpellingRetry(request, run) {
  const root = requestProjectRoot(request);
  if (root === null) return await run(request);
  return await withOnDiskSpellingRetry(root, (spelled) => run(spelled === root ? request : withRequestProjectRoot(request, root, spelled)));
}

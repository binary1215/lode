import path from "node:path";

// Path-escape predicates for a path.relative(root, target) result. Two forms
// exist and are kept exactly as their callers used them.

// Prefix form: any relative path starting with ".." (including a name such as
// "..data") or an absolute path counts as outside.
export function escapesRootByPrefix(relative) {
  return relative.startsWith("..") || path.isAbsolute(relative);
}

// Segment form: only ".." itself, a "../" segment prefix or an absolute path
// counts as outside.
export function escapesRoot(relative) {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

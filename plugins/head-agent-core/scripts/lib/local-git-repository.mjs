import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

// Shared discovery for user-repository readers only, never the private SHA256
// snapshot store. No commands, registry, binding, remote access or writes here.
export function resolveLocalGitRepository(root, { allowParent = false } = {}) {
  const projectRoot = fs.realpathSync(root), proofs = [], directories = [];
  function directory(file) {
    const absolute = path.resolve(file);
    let current = path.parse(absolute).root;
    for (const segment of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("LOCAL_GIT_METADATA_PATH_UNSAFE");
    }
    const stat = fs.statSync(absolute), real = fs.realpathSync(absolute);
    directories.push({ path: absolute, dev: stat.dev, ino: stat.ino, real });
    return real;
  }
  function physicalMetadata(file) {
    const named = fs.lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > 32 * 1024) fail("LOCAL_GIT_METADATA_UNAVAILABLE");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = fs.fstatSync(fd), bytes = Buffer.alloc(named.size + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0), after = fs.fstatSync(fd), current = fs.lstatSync(file);
      if (before.dev !== named.dev || before.ino !== named.ino || before.size !== count || count !== named.size
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || current.nlink !== 1) fail("LOCAL_GIT_MAPPING_DRIFT");
      return { bytes: bytes.subarray(0, count), stat: after };
    } finally { fs.closeSync(fd); }
  }
  function metadata(file) {
      directory(path.dirname(file));
      const { bytes: body, stat: after } = physicalMetadata(file), text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      if (text.includes("\0")) fail("LOCAL_GIT_METADATA_UNAVAILABLE");
      proofs.push({ file, dev: after.dev, ino: after.ino, size: after.size, digest: hash(body) });
      return text;
  }
  const singleLine = text => {
    const line = text.replace(/\r?\n$/, "");
    if (!line || /[\r\n]/.test(line)) fail("LOCAL_GIT_METADATA_UNAVAILABLE");
    return line;
  };
  let worktreeRoot = projectRoot, marker;
  while (!(marker = fs.lstatSync(path.join(worktreeRoot, ".git"), { throwIfNoEntry: false }))) {
    const parent = path.dirname(worktreeRoot);
    if (!allowParent || parent === worktreeRoot) return { status: "not-a-git-repository", reasonCode: "LOCAL_GIT_NOT_A_REPOSITORY" };
    worktreeRoot = parent;
  }
  const gitFile = path.join(worktreeRoot, ".git");
  let gitDir, commonDir, kind;
  if (marker.isDirectory() && !marker.isSymbolicLink()) {
    gitDir = commonDir = directory(gitFile); kind = "ordinary-directory";
    // An ordinary marker cannot silently redirect to another common store.
    if (fs.lstatSync(path.join(gitDir, "commondir"), { throwIfNoEntry: false })) fail("LOCAL_GIT_MAPPING_NOT_LINKED_WORKTREE");
  } else {
    const directive = singleLine(metadata(gitFile));
    if (!directive.startsWith("gitdir: ")) fail("LOCAL_GIT_MAPPING_NOT_LINKED_WORKTREE");
    gitDir = directory(path.resolve(worktreeRoot, directive.slice(8)));
    commonDir = directory(path.resolve(gitDir, singleLine(metadata(path.join(gitDir, "commondir")))));
    if (path.dirname(gitDir) !== path.join(commonDir, "worktrees")
      || fs.realpathSync(path.resolve(gitDir, singleLine(metadata(path.join(gitDir, "gitdir"))))) !== fs.realpathSync(gitFile)) fail("LOCAL_GIT_MAPPING_NOT_LINKED_WORKTREE");
    kind = "verified-linked-worktree";
  }
  const prefix = path.relative(worktreeRoot, projectRoot).replaceAll("\\", "/");
  const assertCurrent = () => {
    for (const entry of directories) {
      const stat = fs.lstatSync(entry.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino
        || fs.realpathSync(entry.path) !== entry.real) fail("LOCAL_GIT_MAPPING_DRIFT");
    }
    for (const proof of proofs) {
      const { stat, bytes } = physicalMetadata(proof.file);
      if (stat.dev !== proof.dev || stat.ino !== proof.ino || stat.size !== proof.size || hash(bytes) !== proof.digest) fail("LOCAL_GIT_MAPPING_DRIFT");
    }
    const now = fs.lstatSync(gitFile);
    if (now.dev !== marker.dev || now.ino !== marker.ino || now.isSymbolicLink()) fail("LOCAL_GIT_MAPPING_DRIFT");
  };
  assertCurrent();
  return { status: "available", projectRoot, worktreeRoot, gitDir, commonDir, prefix: prefix ? prefix + "/" : "", kind, assertCurrent,
    matchesDiscovery(bytes) {
      assertCurrent();
      const values = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/, "").split(/\r?\n/);
      if (values.length !== 5 || !["sha1", "sha256"].includes(values[4])
        || fs.realpathSync(values[0]) !== gitDir || fs.realpathSync(values[1]) !== commonDir
        || fs.realpathSync(values[2]) !== worktreeRoot || values[3] !== (prefix ? prefix + "/" : "")) fail("LOCAL_GIT_DISCOVERY_MISMATCH");
      return values[4];
    } };
}

export const LOCAL_GIT_DISCOVERY_ARGS = Object.freeze(["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir", "--show-toplevel", "--show-prefix", "--show-object-format"]);
export function localGitReadEnvironment() {
  const environment = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const key of Object.keys(environment)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG(?:_|$))/.test(key)) delete environment[key];
  return environment;
}

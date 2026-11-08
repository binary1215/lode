import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { assertProjectStorageUnchanged } from "./project-storage-format.mjs";
import { sha256Hex } from "./core/digest.mjs";
import { failCode as fail } from "./core/errors.mjs";
import { renamePath } from "./core/fs-atomic.mjs";

const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

export function assertConversationTarget(check) {
  try {
    const value = check?.();
    if (value && typeof value.then === "function") {
      Promise.resolve(value).catch(() => {});
      fail("CONVERSATION_TARGET_CHECK_MUST_BE_SYNCHRONOUS");
    }
  } catch (cause) {
    const code = cause?.code || "CONVERSATION_TARGET_REFUSED";
    throw Object.assign(new Error(code, { cause }), { code, conversationTargetRefused: true });
  }
}

// P5 confined mailbox/Host-registry I/O. Check the selected Project and every physical ancestor
// at each operation, including after an await. This is not an OS sandbox or an
// atomicity guarantee against an arbitrary non-cooperating filesystem writer.
export function conversationHostDirectory(environment, projectRoot) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) return null;
  const digest = sha256Hex(path.resolve(projectRoot));
  const home = environment?.HOME || environment?.USERPROFILE;
  if (typeof home === "string" && path.isAbsolute(home)) return path.join(home, ".local", "state", "lode-agent-core", "conversation-tickets", digest);
  const operational = environment?.LODE_AGENT_OPERATIONAL_STATE_ROOT || environment?.HEAD_AGENT_OPERATIONAL_STATE_ROOT;
  return typeof operational === "string" && path.isAbsolute(operational) ? path.join(operational, "conversation-tickets", digest) : null;
}

export function conversationPresenceStorage(storage, environment) {
  const directory = conversationHostDirectory(environment, storage.projectRoot);
  if (!directory) fail("CONVERSATION_REGISTRATION_KEY_UNAVAILABLE");
  const base = path.join(directory, "registry");
  return { directory: base, io: confinedStorage(storage, path.parse(base).root, base) };
}

export function conversationMailboxStorage(storage) {
  return confinedStorage(storage, storage.projectRoot, path.join(storage.projectRoot, storage.directory, "messaging"));
}

function confinedStorage(storage, root, base) {
  const rootIdentity = fs.lstatSync(root, { bigint: true });
  const projectIdentity = fs.lstatSync(storage.projectRoot, { bigint: true });
  const markerIdentity = fs.lstatSync(storage.projectFile, { bigint: true });
  const observed = new Map();
  function check(file, { directory = false, ancestor = false } = {}) {
    const currentRoot = fs.lstatSync(root, { bigint: true });
    if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || !same(rootIdentity, currentRoot)) fail("CONVERSATION_PATH_CHANGED");
    const currentProject = fs.lstatSync(storage.projectRoot, { bigint: true });
    if (!currentProject.isDirectory() || currentProject.isSymbolicLink() || !same(projectIdentity, currentProject)) fail("CONVERSATION_PATH_CHANGED");
    const target = path.resolve(file),
      rel = path.relative(root, target);
    const mailboxRel = path.relative(base, target);
    if (
      rel === ".." ||
      rel.startsWith(".." + path.sep) ||
      path.isAbsolute(rel) ||
      ((!ancestor || !isAncestor(target, base)) && (mailboxRel === ".." || mailboxRel.startsWith(".." + path.sep) || path.isAbsolute(mailboxRel)))
    )
      fail("CONVERSATION_PATH_ESCAPE");
    let current = root;
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current, { bigint: true, throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isSymbolicLink() || ((current !== target || directory) && !stat.isDirectory())) fail("CONVERSATION_PATH_ESCAPE");
      if (stat.isDirectory()) {
        const previous = observed.get(current);
        if (previous && !same(previous, stat)) fail("CONVERSATION_PATH_CHANGED");
        observed.set(current, stat);
      } else if (!stat.isFile() || stat.nlink !== 1n) fail("CONVERSATION_UNSAFE_FILE");
    }
    // The public operation selected and decoded this Project once. Between
    // awaits/effects, pin its exact physical original rather than reparsing the
    // complete Project for every stat/read of every message.
    const marker = fs.lstatSync(storage.projectFile, { bigint: true });
    if (
      !marker.isFile() ||
      marker.isSymbolicLink() ||
      !same(markerIdentity, marker) ||
      marker.size !== markerIdentity.size ||
      marker.ctimeNs !== markerIdentity.ctimeNs ||
      marker.mtimeNs !== markerIdentity.mtimeNs
    )
      fail("PROJECT_IDENTITY_MISMATCH");
    return target;
  }
  function isAncestor(parent, child) {
    const relative = path.relative(parent, child);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  }
  function mkdir(directory) {
    check(directory, { directory: true });
    // Never recursively follow a newly inserted intermediate directory.
    const anchor = fs.existsSync(base) ? base : root;
    const rel = path.relative(anchor, directory);
    let current = anchor;
    for (const part of ["", ...rel.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      check(current, { directory: true, ancestor: true });
      if (!fs.existsSync(current)) {
        try {
          fs.mkdirSync(current, { mode: 0o700 });
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
      }
      check(current, { directory: true, ancestor: true });
    }
  }
  function opened(file, flags, use) {
    check(file);
    const before = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    const fd = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      check(file);
      const atPath = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || !same(stat, atPath) || (before && !same(before, stat))) fail("CONVERSATION_PATH_CHANGED");
      const value = use(fd, stat);
      check(file);
      if (!same(stat, fs.lstatSync(file, { bigint: true }))) fail("CONVERSATION_PATH_CHANGED");
      return value;
    } finally {
      fs.closeSync(fd);
    }
  }
  function publish(file, content, createOnly, beforePublish) {
    mkdir(path.dirname(file));
    const temp = path.join(path.dirname(file), "." + path.basename(file) + "." + crypto.randomUUID() + ".writing");
    let owned = null,
      primary;
    try {
      opened(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, (fd, stat) => {
        owned = stat;
        check(temp);
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      });
      beforePublish?.();
      check(file);
      check(temp);
      if (createOnly) {
        fs.linkSync(temp, file);
        check(path.dirname(temp), { directory: true });
        if (!same(owned, fs.lstatSync(temp, { bigint: true }))) fail("CONVERSATION_PATH_CHANGED");
        fs.unlinkSync(temp);
      } else {
        const fingerprint = (target) => {
          check(target);
          const stat = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
          return stat ? `${stat.dev}:${stat.ino}:${sha256Hex(api.readFileSync(target))}` : "missing";
        };
        const original = fingerprint(file),
          stage = fingerprint(temp),
          pause = new Int32Array(new SharedArrayBuffer(4)),
          delays = [5, 10, 20, 40];
        for (let attempt = 0; ; attempt++) {
          beforePublish?.();
          check(file);
          check(temp);
          try {
            renamePath(temp, file);
            break;
          } catch (error) {
            if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= delays.length) throw error;
            const unchanged = () => {
              try {
                if (fingerprint(file) !== original) {
                  error.mailboxRetryBlocked = "target-changed";
                  return false;
                }
                if (fingerprint(temp) !== stage) {
                  error.mailboxRetryBlocked = "stage-changed";
                  return false;
                }
                return true;
              } catch (inspection) {
                error.retryInspection = { code: inspection.code };
                return false;
              }
            };
            if (!unchanged()) throw error;
            Atomics.wait(pause, 0, 0, delays[attempt]);
            if (!unchanged()) throw error;
          }
        }
      }
      check(file);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      try {
        check(temp);
        const stat = fs.lstatSync(temp, { bigint: true, throwIfNoEntry: false });
        if (stat && owned && same(stat, owned)) fs.unlinkSync(temp);
      } catch (error) {
        if (primary) primary.mailboxCleanup = { code: error.code };
        else throw error;
      }
    }
  }
  const api = {
    assertCurrent: () => {
      check(base, { directory: true });
      assertProjectStorageUnchanged(storage);
    },
    check,
    mkdirSync: mkdir,
    atomicCreate: (file, value) => publish(file, value, true),
    atomicWrite: (file, value, { beforePublish } = {}) => publish(file, value, false, beforePublish),
    readFileSync(file, encoding) {
      return opened(file, fs.constants.O_RDONLY, (fd, stat) => {
        if (stat.size > 65536n) fail("CONVERSATION_RECORD_TOO_LARGE");
        const bytes = Buffer.alloc(Number(stat.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const n = fs.readSync(fd, bytes, length, bytes.length - length, null);
          if (!n) break;
          length += n;
        }
        const after = fs.fstatSync(fd, { bigint: true });
        if (BigInt(length) !== stat.size || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs)
          fail("CONVERSATION_PATH_CHANGED");
        return encoding ? bytes.subarray(0, length).toString(encoding) : bytes.subarray(0, length);
      });
    },
    readdirSync(file) {
      check(file, { directory: true });
      const entries = fs.readdirSync(file);
      check(file, { directory: true });
      return entries;
    },
    statSync(file) {
      check(file);
      return fs.lstatSync(file);
    },
    lstatSync(file, options) {
      check(file);
      return fs.lstatSync(file, options);
    },
    writeFileSync(file, value) {
      return opened(file, fs.constants.O_WRONLY, (fd) => {
        check(file);
        fs.ftruncateSync(fd, 0);
        fs.writeFileSync(fd, value);
      });
    },
    utimesSync(file, a, m) {
      return opened(file, fs.constants.O_RDWR, (fd) => {
        check(file);
        fs.futimesSync(fd, a, m);
      });
    },
    renameSync(source, target) {
      check(source);
      check(target);
      renamePath(source, target);
      check(target);
    },
    rmSync(file) {
      check(file);
      try {
        fs.unlinkSync(file);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    },
    existsSync(file) {
      check(file);
      return fs.existsSync(file);
    },
  };
  check(base, { directory: true });
  return Object.freeze(api);
}

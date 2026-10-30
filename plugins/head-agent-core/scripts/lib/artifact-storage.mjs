import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Shared publication primitives. Caller owns identity/authority/path validation
// and writer coordination; these functions never interpret records or retry an
// external effect. Staging stays beside the destination for atomic publication.
function staged(file, content, publish) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let owner, failure, descriptor = null, written = false;
  const expected = crypto.createHash("sha256").update(content).digest("hex");
  try {
    descriptor = fs.openSync(temporary, "wx");
    owner = fs.fstatSync(descriptor);
    fs.writeFileSync(descriptor, content);
    written = true;
    fs.closeSync(descriptor);
    descriptor = null;
    return publish(temporary);
  } catch (error) { failure = error; throw error;
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); }
      catch (error) { if (failure) failure.descriptorCleanup = { code: error.code }; else throw error; }
    }
    try {
      const current = fs.lstatSync(temporary);
      if (!owner || !current.isFile() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino
        || written && crypto.createHash("sha256").update(fs.readFileSync(temporary)).digest("hex") !== expected) {
        throw Object.assign(new Error("Changed staging was preserved, not deleted."), { code: "ARTIFACT_STAGING_CHANGED" });
      }
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (failure) failure.stagingCleanup = { code: error.code, preservedPath: temporary };
        else throw error;
      }
    }
  }
}

export function atomicWriteArtifact(file, content) {
  const fingerprint = (target) => {
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return "unsafe";
      return `${stat.dev}:${stat.ino}:${crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")}`;
    } catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
  };
  return staged(file, content, (temporary) => {
    if (process.platform !== "win32") return fs.renameSync(temporary, file);
    const source = fingerprint(temporary), original = fingerprint(file);
    const delays = [5, 10, 20, 40], pause = new Int32Array(new SharedArrayBuffer(4));
    const unchanged = (failure) => {
      try { return original !== "unsafe" && fingerprint(temporary) === source && fingerprint(file) === original; }
      catch (error) {
        // Unknown comparison is not permission to retry; preserve the original
        // publication failure rather than replacing it with an inspection error.
        failure.retryInspection = { code: error.code ?? "UNKNOWN" };
        return false;
      }
    };
    for (let attempt = 0; ; attempt += 1) {
      try { return fs.renameSync(temporary, file); }
      catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= delays.length) throw error;
        // Retry only an unpublished, unchanged stage against the same target.
        // Never remove the destination or repeat a higher-level external effect.
        if (!unchanged(error)) throw error;
        Atomics.wait(pause, 0, 0, delays[attempt]);
        if (!unchanged(error)) throw error;
      }
    }
  });
}

export function atomicCreateArtifact(file, content) {
  // link is an atomic no-clobber publication: an existing destination wins.
  return staged(file, content, (temporary) => fs.linkSync(temporary, file));
}

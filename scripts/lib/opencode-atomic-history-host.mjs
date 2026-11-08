import fs from "node:fs";
import path from "node:path";
import { inspectCopiedProjectFile, copiedProjectFile } from "./project-copy-evidence.mjs";
import { nativeRoot, nativeCheck, nativeFail, nativeJson, pinNativeRoot } from "./provider-native-history-host.mjs";
import {
  openCodeAtomicProfileIdentity,
  isQualifiedOpenCodeExecutable,
  inspectOpenCodeAtomicBatch,
  publishOpenCodeAtomicBatch,
  readOpenCodeAtomicHistory,
  listOpenCodeAtomicHistory,
} from "./opencode-atomic-history-store.mjs";

// No provider subprocess, bootstrap, DDL, migration, account/config read, prompt
// or default-profile fallback. Only the explicitly selected isolated layout.
export function createOpenCodeAtomicHistoryHost({ executable, nativeHome, root, signal, assertCurrentAuthority = () => {} }) {
  const file = path.resolve(executable),
    parent = nativeRoot(path.dirname(file));
  const original = inspectCopiedProjectFile(parent, path.basename(file));
  if (!isQualifiedOpenCodeExecutable({ platform: process.platform, arch: process.arch, ...original })) nativeFail("NATIVE_OPENCODE_VERSION_UNQUALIFIED");
  const home = nativeRoot(nativeHome),
    project = nativeRoot(root),
    profile = copiedProjectFile(home, "profile");
  if (fs.readdirSync(home).some((name) => !["profile", "native-profile-intent.json", ".lode-native-transfer"].includes(name)))
    nativeFail("NATIVE_OPENCODE_ISOLATED_LAYOUT_REQUIRED");
  if (!fs.existsSync(profile)) nativeFail("NATIVE_OPENCODE_QUALIFIED_PROFILE_REQUIRED");
  nativeRoot(profile);
  const databaseFile = copiedProjectFile(profile, "data/opencode/opencode.db");
  if (!fs.existsSync(databaseFile)) nativeFail("NATIVE_OPENCODE_QUALIFIED_DATABASE_REQUIRED");
  const pins = [home, project, profile, path.dirname(databaseFile)].map(pinNativeRoot);
  const check = () => {
    nativeCheck(signal, assertCurrentAuthority);
    for (const pin of pins) pin.verify();
    copiedProjectFile(profile, "data/opencode/opencode.db");
  };
  const verifyExecutable = () => {
    check();
    const current = inspectCopiedProjectFile(parent, path.basename(file));
    if (current.bytes !== original.bytes || current.sha256 !== original.sha256) nativeFail("NATIVE_HISTORY_EXECUTABLE_CHANGED");
  };
  const route = ({ cwd, home: selectedHome }) => {
    check();
    if (nativeRoot(cwd) !== project || nativeRoot(selectedHome) !== profile) nativeFail("NATIVE_OPENCODE_TARGET_ROUTE_CHANGED");
  };
  const options = { databaseFile, root: project, signal, assertCurrentAuthority: check };
  return Object.freeze({
    provider: "opencode",
    clientVersion: openCodeAtomicProfileIdentity.clientVersion,
    evidenceKind: "qualified-opencode-sqlite-adapter",
    executableDigest: original.sha256,
    atomicProfileId: openCodeAtomicProfileIdentity.profileId,
    async version() {
      verifyExecutable();
      return openCodeAtomicProfileIdentity.clientVersion;
    },
    async observeAtomicBatch({ documents, cwd, home }) {
      route({ cwd, home });
      verifyExecutable();
      const result = inspectOpenCodeAtomicBatch({ ...options, documents });
      verifyExecutable();
      return result;
    },
    async publishAtomicBatch({ documents, cwd, home }) {
      route({ cwd, home });
      verifyExecutable();
      const result = await publishOpenCodeAtomicBatch({ ...options, documents });
      verifyExecutable();
      return result;
    },
    async run({ args, cwd, home }) {
      route({ cwd, home });
      verifyExecutable();
      let value;
      if (args.length === 2 && args[0] === "export") value = readOpenCodeAtomicHistory({ ...options, nativeId: args[1] });
      else if (args.join(" ") === "session list --format json") value = listOpenCodeAtomicHistory(options);
      else nativeFail("NATIVE_HISTORY_COMMAND_NOT_ALLOWED");
      verifyExecutable();
      return { stdout: nativeJson(value), exitCode: 0, providerProcessStarted: false };
    },
  });
}

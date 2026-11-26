// Text for refusals that used to carry only their reason code. The code stays
// the caller's contract; the text says what is wrong in the caller's terms and
// what to do next. Only the modules on the init, resume, status and
// conversation-entry paths use this table (first-use bundle, beta.137).
import { fail } from "./errors.mjs";

const RUNTIMES = ["claude", "codex", "opencode"];

// One wording wherever a requested runtime set differs from the recorded one.
export function runtimeMismatchText(recorded, requested) {
  const known = (list) => (Array.isArray(list) && list.length ? list.join(", ") : "none");
  const flag = Array.isArray(recorded) && recorded.length ? recorded.join(",") : RUNTIMES.join(",");
  return (
    `This Project was set up for the runtimes ${known(recorded)}; the request named ${known(requested)}. ` +
    `Repeat with the recorded set (CLI --runtime ${flag}, MCP runtimes) or leave the runtimes out. ` +
    "Lode has no step that changes the runtime set of an existing Project."
  );
}

export const REFUSAL_TEXT = Object.freeze({
  UNSUPPORTED_RUNTIME: `The requested runtimes must be a list of runtime names (${RUNTIMES.join(", ")}).`,
  PROJECT_COPY_IMMUTABLE_CONFLICT:
    "A location record Lode would create for this copied Project already exists with different content. Nothing was overwritten; inspect the copy's project-location records before resuming again.",
  PROJECT_COPY_PACKAGE_INVALID:
    "The Lode plugin package has no readable version, so the copy cannot be checked against it. Reinstall or update the plugin, then resume again.",
  PROJECT_COPY_PUBLICATION_CONFLICT:
    "A pending adoption of this copied Project does not match its recorded transition. No file was overwritten; inspect the pending location record before resuming again.",
  PROJECT_COPY_SOURCE_CHANGED:
    "Project files changed while Lode was checking them, or differ from the copy's recorded inventory. Nothing was adopted or repaired; stop other writers and try again.",
  PROJECT_RELOCATION_PENDING:
    "A location change of this Project to this folder is already pending. Resume the Project here (without the copied-project choice) to finish it first.",
  PROJECT_REPAIR_MANIFEST_INVALID:
    "The managed-file manifest (generated/manifest.json) is malformed, so Lode cannot tell which files it manages. Nothing was changed; restore the manifest from the original Project.",
  PROJECT_NOT_READY:
    "Managed project files differ from their recorded versions. Nothing was changed; status names the files, and resume restores only files whose line endings changed.",
  PROJECT_BUNDLE_WRITE_FAILED: "Lode could not write a bundle file. Check that the destination is writable and has free space, then export again.",
  PROJECT_COPY_AUTHORITY_CHECK_INVALID:
    "An authority check passed to the copy was not a synchronous function. This is a caller error in the code that called Lode, not a problem in the Project.",
  PROJECT_COPY_SYNCHRONOUS_AUTHORITY_REQUIRED:
    "An authority check passed to the copy returned a promise; it must answer synchronously. This is a caller error in the code that called Lode, not a problem in the Project.",
  PROJECT_COPY_CANCELLED: "The copy was cancelled before it finished. Files already written stay as they are; run the operation again.",
  PROJECT_PORTABILITY_CANCELLED: "The operation was cancelled before it finished. Files already written stay as they are; run it again.",
  PROJECT_COPY_EXCERPT_INVALID: "A copied excerpt record is malformed. Nothing was adopted; restore that record from the original Project.",
  PROJECT_COPY_INVENTORY_INVALID: "The copied Project's file inventory is malformed. Nothing was adopted; restore the Project folder from the original.",
  PROJECT_COPY_PATH_ALIAS:
    "Two recorded paths in the copied Project name the same file (a case or link alias). Nothing was adopted; remove the duplicate before trying again.",
  PROJECT_COPY_PATH_INVALID: "A recorded path in the copied Project is malformed or points outside the Project folder. Nothing was adopted.",
  PROJECT_COPY_UNSAFE_FILE:
    "A file in the copied Project is a link or not a regular file, which Lode does not follow. Replace it with the regular file and try again.",
  PROJECT_COPY_UNSAFE_PATH: "A folder on a copied Project path is a link, which Lode does not follow. Replace it with the real folder and try again.",
  PROJECT_COPY_REFERENCE_INVALID: "A record in the copied Project refers to another record by a malformed id. Nothing was adopted.",
  INVALID_CANON: "The copied Project's metadata is malformed. Nothing was adopted; restore it from the original Project.",
  INVALID_SESSION_CANON: "A copied Session record is malformed. Nothing was adopted; restore it from the original Project.",
  INVALID_PROJECT_DIRECTION: "The copied common direction record is malformed. Nothing was adopted; restore it from the original Project.",
  PROJECT_DIRECTION_UNAVAILABLE:
    "The copied Project has common direction revisions but no current direction pointer. Nothing was adopted; restore the pointer from the original Project.",
  COMPACTION_RUN_POINTER_MISMATCH: "A copied Session checkpoint points at a Run that does not match it. Nothing was adopted.",
  RUN_LINEAGE_KIND_MISMATCH: "A copied Run record has an unexpected kind. Nothing was adopted.",
  RUN_SESSION_MISMATCH: "A copied Run record belongs to another Session than the one that names it. Nothing was adopted.",
  PROJECT_REPAIR_BACKUP_CONFLICT:
    "A backup Lode would keep before restoring line endings already exists with different content. Nothing was changed; inspect the existing backup first.",
  PROJECT_REPAIR_INTENT_INVALID: "A pending line-ending repair record is malformed. Nothing was changed; inspect the pending repair record first.",
  SNAPSHOT_GIT_INVENTORY_LIMIT: "The copied Project's snapshot store holds more Git objects than Lode checks in one pass. Nothing was adopted.",
});

// failCode with text: a module on the first-use path imports this as its
// fail. An explicit message still wins.
export function failExplained(code, message = REFUSAL_TEXT[code] ?? code) {
  return fail(message, code);
}

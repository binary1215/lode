import { isDeepStrictEqual } from "node:util";
import { codexNativePortabilityProfile } from "./codex-native-portability.mjs";
import { readTypedSqliteRows, decodeSqliteCell } from "./native-sqlite-values.mjs";
import { decodeCodexExplicitSelectionEvidence } from "./codex-explicit-project-selection.mjs";

const profile = codexNativePortabilityProfile();
const projectColumns = ["id", "name"];
const membershipColumns = ["id", "project_id", "cwd", "archived", "source", "attached_thread_parent_id"];
const explicitMembershipColumns = [...membershipColumns, "rollout_path"];
const explicitCoverage = Object.freeze({
  selection: "current-caller-exact-IDs-not-Host-authentication",
  projectReference: "caller-reference-in-separate-namespace-not-native-membership",
  nativeState: "exact-selected-rows-in-one-read-snapshot",
  nativeProjectAssociations: "original-values-including-null-preserved",
  appMembershipVerifiedByCore: false, appMembershipCompletenessClaimed: false,
  workspaceScope: "single-caller-source-root-physical-identity-checked-at-intake",
  nullFileIdentityMeaning: "observed-absent-requires-new-observation-if-present",
  cwdOnlyConversationsAdded: false, filesAndAttachments: "not-captured-by-catalog",
});
const coverage = Object.freeze({
  projectHeader: "selected-project-id-and-display-name-only",
  unselectedConversations: "membership-metadata-only-no-title-or-message",
  nativeState: "all-exact-project-id-rows-in-one-read-snapshot",
  archived: "included-without-filter",
  sourceKindsAndWorkspaces: "included-without-filter",
  hostInventory: "not-observed",
  logOnlyAndEphemeralConversations: "not-observed",
  filesAndAttachments: "not-captured-by-catalog",
});
const fail = (code = "NATIVE_CODEX_PROJECT_CATALOG_INVALID") => {
  throw Object.assign(new Error(code), { code });
};
const exactId = value => typeof value === "string" && value.length > 0 && value.trim() === value;
const shape = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), names.slice().sort());

// The database is supplied by the pinned/offline capture adapter. A savepoint
// keeps both SELECTs on the same SQLite snapshot, including an existing outer
// transaction. It neither commits that outer transaction nor closes the DB.
// This is historical P3 membership, not a Host-wide completeness assertion.
export function readCodexProjectCatalog(database, projectId) {
  if (!exactId(projectId)) fail("NATIVE_CODEX_PROJECT_ID_REQUIRED");
  database.exec("SAVEPOINT codex_project_catalog");
  let primary;
  try {
    const projects = readTypedSqliteRows(database, "projects", projectColumns, {
      where: 'WHERE "id" = ?', parameters: [projectId],
    });
    if (projects.length !== 1) fail("NATIVE_CODEX_PROJECT_NOT_FOUND");
    // Catalogs are proof metadata, not unselected conversation excerpts.
    // In particular, never SELECT first_user_message, preview or account fields.
    const membershipRows = readTypedSqliteRows(database, "threads", membershipColumns, {
      where: 'WHERE "project_id" = ?', parameters: [projectId], orderBy: ["id"],
    });
    const catalog = {
      schemaVersion: 1, kind: "CodexProjectCatalog", authorityPlane: "P3",
      profileId: profile.profileId, projectId,
      projectEvidence: { columns: [...projectColumns], rows: projects },
      threadIds: membershipRows.map(row => decodeSqliteCell(row[0])),
      membershipEvidence: { columns: [...membershipColumns], rows: membershipRows }, coverage: { ...coverage },
      targetPolicyAuthority: false, grantsRecoveryAuthority: false,
      establishesLogicalSessionOwnership: false,
    };
    verifyCodexProjectCatalog(catalog);
    return catalog;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try { database.exec("RELEASE codex_project_catalog"); }
    catch (error) {
      if (primary) primary.catalogCleanupFailure = error.code || "SQLITE_SAVEPOINT_RELEASE_FAILED";
      else throw error;
    }
  }
}

export function verifyCodexProjectCatalog(catalog) {
  if (catalog?.kind === "CodexExplicitConversationCatalog") return verifyExplicitCatalog(catalog);
  if (!shape(catalog, ["schemaVersion", "kind", "authorityPlane", "profileId", "projectId", "projectEvidence",
    "threadIds", "membershipEvidence", "coverage", "targetPolicyAuthority", "grantsRecoveryAuthority", "establishesLogicalSessionOwnership"])
    || catalog?.schemaVersion !== 1 || catalog.kind !== "CodexProjectCatalog"
    || catalog.authorityPlane !== "P3" || catalog.profileId !== profile.profileId
    || !exactId(catalog.projectId) || !shape(catalog.projectEvidence, ["columns", "rows"])
    || !isDeepStrictEqual(catalog.projectEvidence?.columns, projectColumns)
    || !Array.isArray(catalog.projectEvidence?.rows) || catalog.projectEvidence.rows.length !== 1
    || !isDeepStrictEqual(catalog.coverage, coverage) || !Array.isArray(catalog.threadIds)
    || catalog.targetPolicyAuthority !== false || catalog.grantsRecoveryAuthority !== false
    || catalog.establishesLogicalSessionOwnership !== false) fail();
  const row = catalog.projectEvidence.rows[0];
  if (!Array.isArray(row) || row.length !== projectColumns.length) fail();
  const project = Object.fromEntries(projectColumns.map((name, index) => [name, decodeSqliteCell(row[index])]));
  if (project.id !== catalog.projectId) fail();
  if (!shape(catalog.membershipEvidence, ["columns", "rows"]) || !isDeepStrictEqual(catalog.membershipEvidence?.columns, membershipColumns)
    || !Array.isArray(catalog.membershipEvidence?.rows)
    || catalog.membershipEvidence.rows.length !== catalog.threadIds.length) fail();
  const records = catalog.membershipEvidence.rows.map(row => {
    if (!Array.isArray(row) || row.length !== membershipColumns.length) fail();
    return Object.fromEntries(membershipColumns.map((name, index) => [name, decodeSqliteCell(row[index])]));
  });
  if (new Set(catalog.threadIds).size !== catalog.threadIds.length || catalog.threadIds.some(id => !exactId(id))) fail();
  if (records.some(record => record.project_id !== catalog.projectId)
    || !isDeepStrictEqual(records.map(record => record.id), catalog.threadIds)
    || catalog.threadIds.some((id, index) => index && catalog.threadIds[index - 1] >= id)) fail();
  return { project, records };
}

// Explicit current caller selection is distinct from a native Project roster.
// No native project_id is fabricated or changed to the app reference ID.
export function readCodexExplicitProjectCatalog(database, selection) {
  const document = decodeCodexExplicitSelectionEvidence(selection.evidence);
  const ids = document.members.map(row => row.id).sort();
  const rows = ids.flatMap(id => readTypedSqliteRows(database, "threads", explicitMembershipColumns,
    { where: 'WHERE "id" = ?', parameters: [id] }));
  const projects = [...new Set(rows.map(row => decodeSqliteCell(row[explicitMembershipColumns.indexOf("project_id")])).filter(id => id !== null))].sort()
    .flatMap(id => readTypedSqliteRows(database, "projects", projectColumns, { where: 'WHERE "id" = ?', parameters: [id] }));
  const catalog = { schemaVersion: 1, kind: "CodexExplicitConversationCatalog", authorityPlane: "P3", profileId: profile.profileId,
    projectId: document.projectReference.id, projectReference: structuredClone(document.projectReference), selectionEvidence: structuredClone(selection.evidence),
    threadIds: ids, membershipEvidence: { columns: [...explicitMembershipColumns], rows }, nativeProjectEvidence: { columns: [...projectColumns], rows: projects },
    coverage: { ...explicitCoverage }, targetPolicyAuthority: false, grantsRecoveryAuthority: false, establishesLogicalSessionOwnership: false };
  verifyExplicitCatalog(catalog); return catalog;
}

function verifyExplicitCatalog(catalog) {
  if (!shape(catalog, ["schemaVersion", "kind", "authorityPlane", "profileId", "projectId", "projectReference", "selectionEvidence", "threadIds",
    "membershipEvidence", "nativeProjectEvidence", "coverage", "targetPolicyAuthority", "grantsRecoveryAuthority", "establishesLogicalSessionOwnership"])
    || catalog.schemaVersion !== 1 || catalog.authorityPlane !== "P3" || catalog.profileId !== profile.profileId
    || !isDeepStrictEqual(catalog.coverage, explicitCoverage)
    || ["targetPolicyAuthority", "grantsRecoveryAuthority", "establishesLogicalSessionOwnership"].some(key => catalog[key] !== false)) fail("CODEX_EXPLICIT_CATALOG_INVALID");
  const document = decodeCodexExplicitSelectionEvidence(catalog.selectionEvidence), selectedIds = document.members.map(row => row.id).sort();
  if (catalog.projectId !== document.projectReference.id || !isDeepStrictEqual(catalog.projectReference, document.projectReference)
    || !isDeepStrictEqual(catalog.threadIds, selectedIds) || !shape(catalog.membershipEvidence, ["columns", "rows"])
    || !isDeepStrictEqual(catalog.membershipEvidence.columns, explicitMembershipColumns) || !Array.isArray(catalog.membershipEvidence.rows)
    || catalog.membershipEvidence.rows.length !== selectedIds.length) fail("CODEX_EXPLICIT_CATALOG_INVALID");
  const records = catalog.membershipEvidence.rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== explicitMembershipColumns.length) fail("CODEX_EXPLICIT_CATALOG_INVALID");
    const record = Object.fromEntries(explicitMembershipColumns.map((name, i) => [name, decodeSqliteCell(row[i])]));
    const expected = document.members.find(row => row.id === selectedIds[index]);
    if (record.id !== expected.id || record.project_id !== expected.nativeProjectId || record.cwd !== expected.cwd || record.rollout_path !== expected.rolloutPath)
      fail("CODEX_EXPLICIT_SELECTION_NATIVE_METADATA_CHANGED");
    return record;
  });
  if (!shape(catalog.nativeProjectEvidence, ["columns", "rows"]) || !isDeepStrictEqual(catalog.nativeProjectEvidence.columns, projectColumns)
    || !Array.isArray(catalog.nativeProjectEvidence.rows)) fail("CODEX_EXPLICIT_CATALOG_INVALID");
  const nativeProjects = catalog.nativeProjectEvidence.rows.map(row => {
    if (!Array.isArray(row) || row.length !== projectColumns.length) fail("CODEX_EXPLICIT_CATALOG_INVALID");
    return Object.fromEntries(projectColumns.map((name, i) => [name, decodeSqliteCell(row[i])]));
  });
  const nativeIds = [...new Set(records.map(row => row.project_id).filter(id => id !== null))].sort();
  if (nativeProjects.some(row => !exactId(row.id)) || !isDeepStrictEqual(nativeProjects.map(row => row.id), nativeIds)) fail("CODEX_EXPLICIT_CATALOG_INVALID");
  return { project: { ...document.projectReference, sourceNamespace: "caller-project-reference-not-native-membership" }, records,
    nativeProjects, appMembershipVerifiedByCore: false, selectionIsPermission: false };
}

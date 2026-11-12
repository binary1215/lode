# Reason code audit

Surveyed: 2026-11-12, on 0.3.0-beta.115 (`main` b466613). The script does not
count this report itself.

This audit counts, for every reason code in `REASON_CODES`
(`scripts/lib/core/errors.mjs`), what uses the code itself rather than its
message. It changes no code. It is the survey step of design item 4.6. A later
merge step may group codes nothing uses; this audit only gives the numbers and
the candidates for that decision.

Regenerate the numbers with `node scripts/audit-reason-codes.mjs`. Add `--json`
for every row.

## Method

The script reads every tracked file once and classifies each occurrence of a
listed code:

| Category | Where | Counts as |
| --- | --- | --- |
| prefix branch | shipped `code.startsWith("PREFIX")` | consumed |
| branch | shipped line that compares it (`===`, `!==`, `case`, `includes`, `has`, `test`) | consumed |
| keyed | shipped object key (`CODE: …`) | consumed |
| listed | shipped array or `Set` literal entry | consumed (usually a branch set) |
| Go | `native/**/*.go` | consumed (the Go worker or bridge emits or reads it) |
| documented | English `docs/`, `README.md` or `skills/` | documented |
| tested | `test/`, `scripts/verify-*`, codemods | tested |
| emit | any other shipped occurrence (`fail(…)`, a `code` field) | neither |

A **quiet** code is neither consumed nor documented. Nothing outside its own
`throw` reads it, so an agent or a user learns only from the message. The counts
are line-based and heuristic. A comparison split over several lines can be
missed, and so can a code passed through a variable. A quiet code is therefore a
candidate to check, not a proven unused one.

## Summary

| Measure | Codes |
| --- | --- |
| Listed in `REASON_CODES` | 2,721 |
| Consumed in shipped code or Go | 356 |
| — compared directly | 185 |
| — covered by a prefix branch | 20 |
| — only keyed in a map | 5 |
| — only listed in an array or `Set` | 145 |
| — named in Go sources | 17 |
| Documented in English docs or skills | 28 (8 in skills) |
| Asserted by tests or verifiers | 832 |
| **Quiet** | **2,351** (86%) |
| — quiet but asserted by a test | 618 |
| — quiet and never asserted | 1,733 |
| With a legacy `HEAD_*` spelling still carried | 121 |

**Prefix branches.** Four prefixes branch on a group of codes:
- `CONVERSATION_PATH` (4 sites, `conversation-messaging.mjs`);
- `SOURCE_EXPORT_` (`portable-source-originals.mjs`);
- `SESSION_RESTORE_` and `SESSION_RUN_` (`recovery-checkpoint-diagnosis.mjs`).

Merging codes inside those groups changes behaviour unless the prefix is kept.

**Not emitted by shipped JavaScript:** six codes appear only in verifiers:
- `LIVE_CODEX_E2E_*` (3);
- `LIVE_RUNTIME_E2E_OPT_IN_REQUIRED`;
- `PROCESS_SUPERVISOR_VERIFY_ERROR`;
- `RUNTIME_LIFECYCLE_VERIFY_ERROR`.

## By area

The area is the code's first word. Areas with at least 20 codes:

| Area | Codes | Consumed | Documented | Quiet | Quiet, tested |
| --- | --- | --- | --- | --- | --- |
| `INVALID_*` | 576 | 60 | 4 | 515 | 100 |
| `NATIVE_*` | 252 | 40 | 3 | 209 | 61 |
| `CODEX_*` | 180 | 13 | 0 | 167 | 69 |
| `PROJECT_*` | 137 | 21 | 3 | 115 | 28 |
| `RUNTIME_*` | 92 | 10 | 1 | 82 | 29 |
| `ARCADEDB_*` | 83 | 12 | 0 | 71 | 15 |
| `DOCUMENT_*` | 78 | 5 | 1 | 72 | 9 |
| `ONBOARDING_*` | 74 | 6 | 0 | 68 | 11 |
| `PRODUCT_*` | 74 | 3 | 0 | 71 | 12 |
| `WORKER_*` | 61 | 18 | 0 | 43 | 23 |
| `SESSION_*` | 48 | 17 | 1 | 31 | 16 |
| `SNAPSHOT_*` | 47 | 12 | 1 | 34 | 16 |
| `SOURCE_*` | 45 | 23 | 0 | 22 | 7 |
| `UNSUPPORTED_*` | 42 | 6 | 0 | 36 | 6 |
| `REFRESH_*` | 41 | 1 | 1 | 40 | 3 |
| `CHANGE_*` | 35 | 2 | 0 | 33 | 2 |
| `CLAUDE_*` | 34 | 1 | 0 | 33 | 6 |
| `FEATURE_*` | 33 | 4 | 0 | 29 | 7 |
| `CONVERSATION_*` | 32 | 7 | 1 | 24 | 7 |
| `GRAPH_*` | 32 | 2 | 2 | 28 | 10 |
| `WORK_*` | 32 | 4 | 0 | 28 | 8 |
| `DISTRIBUTION_*` | 31 | 0 | 0 | 31 | 10 |
| `DUPLICATE_*` | 30 | 3 | 0 | 27 | 7 |
| `HISTORICAL_*` | 30 | 0 | 0 | 30 | 2 |
| `RUN_*` | 30 | 1 | 1 | 29 | 14 |
| `CONFORMANCE_*` | 27 | 5 | 1 | 22 | 8 |
| `PREPARED_*` | 27 | 3 | 0 | 24 | 8 |
| `TEMPORAL_*` | 27 | 2 | 0 | 25 | 7 |
| `BOUNDED_*` | 26 | 6 | 0 | 20 | 8 |
| `COMPACTION_*` | 25 | 6 | 0 | 19 | 8 |
| `GC_*` | 22 | 0 | 0 | 22 | 4 |
| `OBSERVATION_*` | 21 | 7 | 0 | 14 | 2 |
| `UNKNOWN_*` | 21 | 2 | 0 | 19 | 2 |
| `WORLD_*` | 21 | 4 | 1 | 17 | 5 |
| `POST_*` | 20 | 0 | 0 | 20 | 1 |

Quiet codes by last word:

| Last word | Quiet codes |
| --- | --- |
| (`INVALID_*` prefix) | 515 |
| `MISMATCH` | 397 |
| `INVALID` | 131 |
| `CONFLICT` | 114 |
| `REQUIRED` | 109 |
| `ERROR` | 86 |
| `UNAVAILABLE` | 69 |
| `MISSING` | 64 |
| `DRIFT` | 57 |
| `FOUND` | 50 |
| `LIMIT` | 45 |

## Documented codes

These 28 codes are named in English docs or skills, so an agent may branch on
them:
- `COMPUTE_OUTPUT_LIMIT`, `CONFORMANCE_RESOLUTION_STALE`,
  `CONVERSATION_ENTRY_BASIS_CHANGED`, `DIVERGENT_DEPLOYMENT_RESULT_REPLAY`
- `DOCUMENT_PROJECTION_UNREVIEWED_DRIFT`, `GRAPH_PROJECTION_STALE`,
  `GRAPH_SNAPSHOT_RECEIPT_SELF_REFERENCE`, `INVALID_SESSION_INPUT`
- `INVALID_SESSION_WORK_EVIDENCE`, `INVALID_SNAPSHOT_COMPOSITION`,
  `INVALID_TOOL_ARGUMENTS`, `MANAGED_OPERATION_NOT_ON_DEFAULT_SURFACE`
- `NATIVE_HOOK_DIRECT_INGRESS_REQUIRED`, `NATIVE_HOOK_INGRESS_REQUIRED`,
  `NATIVE_OPENCODE_BOOTSTRAP_UNQUALIFIED`, `NOT_INITIALIZED`
- `NO_PENDING_REVIEW`, `PROJECT_NATIVE_RUNTIME_ROOT_NOT_USED`,
  `PROJECT_NOT_READY`, `PROJECT_RELOCATION_PENDING`
- `RECOVERY_BASIS_NOT_HELD`, `REFRESH_WRITER_BUSY`,
  `RUNTIME_ADAPTER_CONTROL_NOT_ENABLED`, `RUN_RESULT_LEGACY_INTEGRATION_PENDING`
- `SESSION_PATH_ESCAPE`, `SNAPSHOT_GIT_EXECUTABLE_UNAVAILABLE`,
  `STORAGE_VERSION_MISMATCH`, `WORLD_MODEL_CANON_BASIS_CONFLICT`

## Merge candidates

These are proposals for the merge decision, not changes. Every candidate keeps
the human-readable message. Under design 4.6, the old code is still returned in
a separate response field for two minor versions.

1. **Keep as is.** Keep all 356 consumed codes and the 28 documented ones. Inside
   the four prefix-branch groups, keep at least the prefix.
2. **First candidates.** These are the 1,733 quiet codes that no test asserts.
   Group each area's codes by their last word into one area code, for example
   `PRODUCT_*_MISMATCH` → `PRODUCT_MISMATCH` and `CODEX_*_INVALID` →
   `CODEX_INVALID`. No test needs to change; only the registry list and the emit
   sites do.
3. **Second candidates.** These are the 618 quiet codes that tests assert. They
   are the same kind of grouping, but each test assertion has to move to the area
   code or the old-code field.
4. **`INVALID_*` (576).** This is the largest family and mostly input or record
   shape checks. One `INVALID_INPUT` (caller input) and one `INVALID_RECORD`
   (stored record) would cover most of it. Only 60 are consumed and 4
   documented.
5. **Out of scope for merging.** The 121 codes that still carry a `HEAD_*`
   legacy spelling follow the 3.6 alias period first.

**Not decided here:**
- whether to merge at all;
- the area code names;
- whether a merged code also returns the old code;
- external consumers outside this repository (Host integrations, user scripts),
  which this audit cannot see.

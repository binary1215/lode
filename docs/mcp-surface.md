# MCP tool surface and deprecated names

Lode lists a small default set of MCP tools and makes every other operation
available through discovery and the two routers. Since 0.3, operations on the same
resource are grouped into one tool that takes an `action`.

## Default list

The ordinary `tools/list` stays at the same 23 tools, with the same names and
schemas. It includes `lode_tools_discover`, `lode_tools_read` and
`lode_tools_call`. Grouping changes only what discovery and the managed
maintenance `tools/list` show.

## Grouped tools

A grouped tool is named after its resource, for example
`lode_bounded_worker_wave`. Its `action` selects exactly one existing operation:

```json
{
  "name": "lode_tools_call",
  "arguments": {
    "name": "lode_bounded_worker_wave",
    "arguments": { "action": "seal", "project_root": "/path/to/project", "wave_id": "bounded-worker-wave-0123456789abcdef01234567" }
  }
}
```

- **Routes.** Each action keeps its operation's route. Read-only actions go
  through `lode_tools_read`; `lode_tools_read` refuses an action that is not
  read-only. Discovery returns `actions`, with each action's `invokeWith`,
  required fields and `executionMode`.
- **Arguments.** The grouped schema declares `action` and every field its actions
  use. Each action still checks its own required and optional fields: Lode
  removes `action` and runs the operation with the remaining arguments.
- **Results.** A grouped call returns exactly what the operation returns, and it
  runs the same Session, write-guard and managed-surface checks.
- **Errors.** A missing or unknown `action` is refused with
  `INVALID_TOOL_ARGUMENTS` before any operation runs.

## Deprecated names

The operation names a group replaced remain callable for two minor versions:
directly, through `lode_tools_read` / `lode_tools_call`, and in their historical
`head_*` spelling. They are removed in the version named in the table header.

- Discovery lists only the grouped tool. Looking up a deprecated name returns that
  grouped tool, whose `deprecatedAliases` lists each old name with its `action`
  and `removedIn` version.
- The Claude Code `PreToolUse` matchers in `hooks/claude.json` cover both the
  grouped tools and the deprecated names.

## Mapping

<!-- generated: mcp-surface-groups (node scripts/generate-mcp-surface-docs.mjs) -->

| Grouped tool | `action` | Route | Deprecated name (0.5.0) |
| --- | --- | --- | --- |
| `lode_bounded_worker` | `prepare` | `lode_tools_call` | `lode_bounded_worker_prepare` |
| `lode_bounded_worker` | `start` | `lode_tools_call` | `lode_bounded_worker_start` |
| `lode_bounded_worker` | `reconcile` | `lode_tools_call` | `lode_bounded_worker_reconcile` |
| `lode_bounded_worker` | `dispatch` | `lode_tools_call` | `lode_bounded_worker_dispatch` |
| `lode_bounded_worker` | `status` | `lode_tools_read` | `lode_bounded_worker_status` |
| `lode_bounded_worker` | `wait` | `lode_tools_read` | `lode_bounded_worker_wait` |
| `lode_bounded_worker` | `apply_result` | `lode_tools_call` | `lode_bounded_worker_apply_result` |
| `lode_bounded_worker_job` | `reconcile` | `lode_tools_call` | `lode_bounded_worker_job_reconcile` |
| `lode_bounded_worker_job` | `patch` | `lode_tools_read` | `lode_bounded_worker_job_patch` |
| `lode_bounded_worker_wave` | `create` | `lode_tools_call` | `lode_bounded_worker_wave_create` |
| `lode_bounded_worker_wave` | `read` | `lode_tools_read` | `lode_bounded_worker_wave_read` |
| `lode_bounded_worker_wave` | `seal` | `lode_tools_call` | `lode_bounded_worker_wave_seal` |
| `lode_bounded_worker_wave` | `status` | `lode_tools_read` | `lode_bounded_worker_wave_status` |
| `lode_bounded_worker_wave` | `results` | `lode_tools_read` | `lode_bounded_worker_wave_results` |
| `lode_bounded_worker_wave` | `wait` | `lode_tools_read` | `lode_bounded_worker_wave_wait` |
| `lode_bounded_worker_wave` | `abandon` | `lode_tools_call` | `lode_bounded_worker_wave_abandon` |

<!-- end generated: mcp-surface-groups -->

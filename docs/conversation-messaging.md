# Same-project conversation messaging

Status: same-project live conversations can be listed and messaged from Claude Code, Codex, and OpenCode. This is not a global directory and it does not grant permission outside the project.

## What a person can do

`lode_conversation_list` shows the other live conversations that have registered in this project's `.lode/messaging/`. Each row has a send address and whether that conversation is reachable now. `lode_conversation_send` delivers text to one of those addresses. A reply is another message: the receiver uses the sender address and `reply_to`.

The result says `delivered` when the receiving client accepted the injection, `sent` when the bytes were handed to a socket, pipe, or prompt hook without confirmation that the model read them, or `queued` when the message is waiting in that conversation's inbox. `unreachable` means this project has no live registration for the address, and nothing is stored for it.

## Scope and identity

The first `lode_conversation_list` or `lode_conversation_send` opens `.lode/messaging/`. Host hooks then register the other live conversations in that project. A Claude Code or Codex session that started before that directory existed is not listed until its own next `SessionStart` or `UserPromptSubmit`. Those hooks do not create the mailbox, and list does not read the client session store. A conversation quiet for 24 hours is omitted from the list and a send to it is `unreachable`. Until then, a conversation that is not on an immediate channel can still be sent to, and the message stays `queued` for the next prompt. A conversation in another project is not listed and cannot be selected by typing an address. The sender is the live caller. Tool arguments cannot name the sender. A subagent address is distinct from its parent, and a subagent prompt does not drain the parent's inbox. Injected body lines are prefixed with `| ` so a body cannot forge a `from:` header. A presence time more than two minutes in the future is treated as stale.

The read-only candidate view on [session work](session-work-context.md) is unchanged. Those candidates still do not authorize contact.

## How each client receives

Claude Code uses the documented inbox socket or native Windows named pipe. The auth line is the documented `{"type":"auth","token":"..."}` form. On native Windows the pipe is not opened unless a token is available from `CLAUDE_CODE_MESSAGING_TOKEN` or the session key file under `CLAUDE_CONFIG_DIR`. A completed write is `sent`, not `delivered`. If the socket is absent, the message stays `queued` until `UserPromptSubmit` injects it once.

Codex immediate delivery uses `codex app-server proxy --sock` only when an ancestor command line contains `app-server --listen unix://`. A plain Codex CLI session has no such ancestor, so `lode_conversation_list` reports `next-prompt` and the message waits for `UserPromptSubmit`. Linux reads `/proc`, macOS reads `ps`, and Windows reads the process table through PowerShell. The socket is the listen path, or the control socket under `CODEX_HOME`, or `~/.codex` when that variable is unset. Delivery calls `thread/resume` and then `turn/start`. A returned turn id is `delivered`. A missing home, a missing socket, a rejected resume, or a Windows spawn rejection leaves the message `queued`. On Windows the proxy is started through `cmd.exe /d /s /c` because Node rejects a direct `codex.cmd` spawn. A socket path containing `%`, a quote, or a cmd separator is not passed to `cmd.exe`, and the message stays `queued`. Stopping the proxy uses `taskkill.exe /T` so the proxy process tree exits with `cmd.exe`. Node does not open the Unix socket itself. Codex runs project hooks only after the person trusts the project directory; until then a Codex session is not registered and does not receive the queued injection.

OpenCode uses v1 `client.session.prompt` when `session.get` exists, and v2 `client.session.prompt` with `delivery` `queue` when `session.get` is absent and `hook`, `wait`, or `command` is present. The `delivery` value `queue` is the v2 plugin argument used here and has not been verified against a shipped OpenCode binary. The system transform does not prompt the session it is already building. An accepted message id is `delivered`. Otherwise the next system transform injects the inbox once and reports `sent`.

## OpenCode caller ticket

An OpenCode call without a host caller carries a short-lived ticket. The signing key is derived from `HOME` or `USERPROFILE` and the project root, not from `LODE_AGENT_OPERATIONAL_STATE_ROOT`, so the plugin and the MCP server use the same file when that variable differs. The key directory is mode `0700` and the key file is mode `0600` on POSIX. A key file that is not 64 hex characters is replaced. A same-user process that can read the key can still sign a ticket. The key stops a different user, and a file committed in the project, from forging the caller.

## What is not canon

`.lode/messaging/` is a live mailbox. New projects ignore `/messaging/` at creation. An existing `.lode/.gitignore` is never rewritten. The mailbox directory gets its own `.gitignore` that ignores every file except that ignore file, so message bodies stay untracked. Each address keeps at most 200 messages and 1 MiB across its inbox, inflight, and archive. One full address does not block a send to a different address. Inbox, inflight, and archive files older than 24 hours are removed, including a queue left for a conversation that has ended. It is not a snapshot, Session record, or migration input. Existing record ids and hashes are unchanged.

# Same-project conversation messaging

Status: same-project live conversations can be listed and messaged from Claude Code, Codex, and OpenCode. This is not a global directory and it does not grant permission outside the project.

## What a person can do

`lode_conversation_list` shows the other live conversations that have registered in this project's `.lode/messaging/`. Each row has a send address and whether that conversation is reachable now. `lode_conversation_send` delivers text to one of those addresses. A reply is another message: the receiver uses the sender address and `reply_to`.

The result says `delivered` when the receiving client accepted the injection, `sent` when the bytes were handed to a socket, pipe, or prompt hook without confirmation that the model read them, or `queued` when the message is waiting in that conversation's inbox. `unreachable` means this project has no live registration for the address, and nothing is stored for it.

## Scope and identity

The first `lode_conversation_list` or `lode_conversation_send` opens `.lode/messaging/`. Host hooks then register the other live conversations in that project. A conversation quiet for 10 minutes is omitted from the list and a send to it is `unreachable`. A conversation in another project is not listed and cannot be selected by typing an address. The sender is the live caller. Tool arguments cannot name the sender. A subagent address is distinct from its parent, and a subagent prompt does not drain the parent's inbox. Injected body lines are prefixed with `| ` so a body cannot forge a `from:` header.

The read-only candidate view on [session work](session-work-context.md) is unchanged. Those candidates still do not authorize contact.

## How each client receives

Claude Code uses the documented inbox socket or native Windows named pipe. The auth line is the documented `{"type":"auth","token":"..."}` form. On native Windows the pipe is not opened unless a token is available from `CLAUDE_CODE_MESSAGING_TOKEN` or the session key file under `CLAUDE_CONFIG_DIR`. A completed write is `sent`, not `delivered`. If the socket is absent, the message stays `queued` until `UserPromptSubmit` injects it once.

Codex uses `codex app-server proxy --sock` when this conversation's process ancestry shows `app-server --listen unix://`. Linux reads `/proc`, macOS reads `ps`, and Windows reads the process table through PowerShell. The socket is the listen path, or the control socket under `CODEX_HOME`, or `~/.codex` when that variable is unset. Delivery calls `thread/resume` and then `turn/start`. A returned turn id is `delivered`. A missing home, a missing socket, a rejected resume, or a Windows spawn rejection leaves the message `queued`. On Windows the proxy is started through `cmd.exe` because Node rejects a direct `codex.cmd` spawn. Node does not open the Unix socket itself.

OpenCode uses v1 `client.session.prompt` when `session.get` exists, and v2 `client.session.prompt` with `delivery` `queue` otherwise. The system transform does not prompt the session it is already building. An accepted message id is `delivered`. Otherwise the next system transform injects the inbox once and reports `sent`.

## What is not canon

`.lode/messaging/` is a live mailbox. New projects ignore `/messaging/` at creation. An existing storage gitignore gains that one line when the mailbox opens, without rewriting earlier rules, unless a user exception already names the mailbox. The mailbox keeps at most 200 messages and 1 MiB; old archive files are removed. It is not a snapshot, Session record, or migration input. Existing record ids and hashes are unchanged.

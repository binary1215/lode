# Same-project conversation messaging

Status: same-project live conversations can be listed and messaged from Claude Code, Codex, and OpenCode. This is not a global directory and it does not grant permission outside the project.

## What a person can do

`lode_conversation_list` shows the other live conversations that have registered in this project's `.lode/messaging/`. Each row has a send address and whether that conversation is reachable now. `lode_conversation_send` delivers text to one of those addresses. A reply is another message: the receiver uses the sender address and `reply_to`.

The result says `delivered` when the receiving client accepted the injection, `sent` when the bytes were handed to a socket, pipe, or prompt hook without confirmation that the model read them, or `queued` when the message is waiting in that conversation's inbox. `unreachable` means this project has no live registration for the address, and nothing is stored for it.

## Scope and identity

Registration happens from the host hook or the OpenCode plugin for the project that is actually open. A conversation in another project is not listed and cannot be selected by typing an address. The sender is the live caller. Tool arguments cannot name the sender. A subagent address is distinct from its parent, and a subagent prompt does not drain the parent's inbox.

The read-only candidate view on [session work](session-work-context.md) is unchanged. Those candidates still do not authorize contact.

## How each client receives

Claude Code uses the documented inbox socket or native Windows named pipe. The auth line is the documented `{"type":"auth","token":"..."}` form. On native Windows the pipe is not opened unless a token is available from `CLAUDE_CODE_MESSAGING_TOKEN` or the session key file under `CLAUDE_CONFIG_DIR`. A completed write is `sent`, not `delivered`. If the socket is absent, the message stays `queued` until `UserPromptSubmit` injects it once.

Codex uses `codex app-server proxy --sock` against the documented control socket under `CODEX_HOME` only when this conversation's process ancestry shows `app-server --listen unix://`. A returned turn id is `delivered`. Otherwise the message stays `queued` for `UserPromptSubmit`. Node does not open the Unix socket itself, including on Windows.

OpenCode uses the v1 plugin client `client.session.prompt` when that method exists. An accepted message id is `delivered`. Otherwise the next system transform injects the inbox once and reports `sent`.

## What is not canon

`.lode/messaging/` is a live mailbox. It is ignored by generated storage rules and is not a snapshot, Session record, or migration input. Existing record ids and hashes are unchanged.

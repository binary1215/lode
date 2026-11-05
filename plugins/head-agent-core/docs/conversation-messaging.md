# Same-project conversation messaging

Lode can show Host-registered conversations in the current Project and pass an authorized message to one address. Listing is read-only. Finding a conversation does not authorize contact; sending still needs the user's instruction.

## Use it in conversation

Ask to see other conversations in this project, then name the recipient and message. The provider uses `lode_conversation_list` and `lode_conversation_send`; the user does not write tickets or JSON. A reply uses the sender address and `reply_to`.

| Result | Meaning |
| --- | --- |
| `delivered` | The client returned an acceptance receipt; this does not prove model completion. |
| `sent` | Bytes reached the local socket/pipe/Hook handoff, without a model-read receipt. |
| `queued` | The message has not been delivered and waits for this recipient's next prompt or OpenCode watcher. |
| `unknown` | The handoff may have occurred. Keep its evidence and do not automatically resend or inject it. |
| `refused` | The current target/identity/path check refused this handoff before payload; preserve its original reason and do not queue it automatically. |
| `unreachable` | No verified reachable registration exists; no message body is queued. |

A peer message is evidence, not user authority, a ReviewDecision, Product Canon, a checkpoint or an instruction to bypass current cancellations. Body lines are framed as data. Subagents have distinct addresses and cannot drain their parent's mailbox.

## Registration and observation

Normal Claude/Codex fresh-start and UserPromptSubmit lifecycle hooks register an initialized Project in a Host-private registry; OpenCode registers through its plugin lifecycle. Recovery SessionStart (resume, clear, compact or fork) and observation-only Hooks do not publish a registration. The next ordinary prompt refreshes it, without blocking on a busy registration/key lock. An already-running client can appear at its next normal lifecycle event. There is no new approval, bind, save or initialization ritual for messaging.

Listing does not create a directory/key, refresh presence, consume a caller ticket or run retention. Unverified old or modified entries can be reported as a registration notice; reading them never upgrades them. A normal trusted Host registration can replace its own operational view. The local signing key, if malformed or unreadable, is preserved rather than silently replaced.

A versioned Host-local signature binds Project/store, address, runtime, native ID, channel and registration generation. A generic heartbeat preserves a richer verified channel for the same identity/epoch. Repeated heartbeats of the same tuple do not invalidate an in-flight send. A new endpoint or identity is revalidated before dispatch and again at queued transport writes. This proves an unchanged local registration tuple, not remote peer authentication against someone controlling the same OS user's key.

Paths are physically checked, file reads are byte-bounded and opened descriptors are matched to the observed file. Junctions, linked files and observed directory replacement are rejected, including after awaits. These checks are not an OS sandbox or an atomicity guarantee against an arbitrary non-cooperating filesystem writer. A failure affects messaging, not ordinary Core or source exploration.

## Provider adapters and verified scope

- Claude uses the observed inbox socket/named pipe. Windows requires its observed peer token before writing; tokens are neither copied into Project records nor logged. A successful write is `sent`. A missing/pre-write connection can queue; a write error or deadline after write admission is `unknown`. The default connection/write bound is 3 seconds.
- Codex immediate delivery requires a shared-engine registration. It uses the existing verified Go supervisor to own the finite proxy process tree; no raw PID/taskkill cleanup is used. The adapter initializes, resumes the exact registered thread and requests a turn without overriding sandbox or approval policy. A returned turn ID is `delivered`; lost confirmation after turn/start is `unknown`. Startup/pre-turn failures queue only when no message turn was sent. Each RPC waits up to 3 seconds, with a finite supervisor lifetime and bounded cleanup. Codex Desktop does not expose a supported pending-turn queue to other tools. When the shared app-server socket is absent, the message stays queued for the next Codex prompt that loads trusted Lode hooks, including a desktop thread. `lode_conversation_list` states this under `desktop.codex`.
- Claude Desktop conversations are not listed. The desktop app does not publish a stable local transcript index, so guessing one would mis-list private history. Claude Code sessions in the project are listed. A message for Claude Code uses the inbox socket when it is connected, and otherwise the next prompt. `desktop.claude` records that limit.
- OpenCode initially queues and its plugin watcher performs the prompt. A returned message ID is `delivered`. An error, timeout or missing receipt after invoking prompt is `unknown`, not a reason to invoke prompt again. Its default wait is 30 seconds; the adapter does not kill a shared Host client or claim that a late SDK request was cancelled. The v2 queue-shaped prompt interface remains unqualified against a shipped OpenCode binary.

Core/MCP/Hook behavior and protocol failure cases are tested with synthetic fixtures, including a real Go-supervised synthetic proxy. This is not acceptance testing of all three installed clients, account connectivity or actual model continuation. Native-history portability remains a separate, pinned Codex metadata feature.

## Caller tickets and storage

OpenCode's before-tool Hook supplies the short-lived caller ticket automatically when needed. List can inspect its signature without consuming it. Send creates one exclusive consumption marker only after the target is reachable and the mailbox accepts the message. An unreachable target or a full mailbox leaves the ticket reusable. Concurrent use admits at most one. A failed consume has no send effect. A consumed ticket cannot be reused after a crash or lost response; report the uncertain original result rather than signing a replacement retry. The key is private Host state derived from HOME/USERPROFILE plus the exact Project root, independent of differing operational-state roots.

`.lode/messaging/` (or the selected legacy store's messaging directory) is disposable Host coordination, not Project/Session recovery state. Project copy/export does not transfer live mailboxes, tickets, process ownership or endpoint bindings. Presence and its registration locks live beside the Host-private per-Project conversation key, outside the Project. Only an explicit send or an existing queued-message handoff writes message state. Empty prompt lookups create nothing. Presence retention runs on registration; mailbox retention runs on explicit sends, never on list. Old Project-side presence is reported as unverified evidence and is never automatically migrated. Observation-only Hooks retain their existing native observation/prompt-reference and already-queued prompt handoff behavior; they do not register presence. Existing user ignore rules, tracked nested markers and unknown Git/index state are preserved. Exact pre-beta75 generated ignore bytes are recognized independently of the new messaging rule; retained snapshots remain retained history, not disposable mail.

An inbox or in-flight file that cannot be read, or whose JSON does not match the message schema, is renamed into `.lode/messaging/quarantine/<id>/payload` with its original bytes. A single `unreadable` notice is updated for that recipient instead of adding one notice per scan. `lode_conversation_list` includes `quarantine.count` and the item ids. One bad file does not stop delivery of the other messages. The same rule applies to Claude Code, Codex, and OpenCode.

Each recipient retains the existing 200-message/1 MiB capacity and 24-hour retention window. One full recipient does not block another. Expired undelivered queues can produce a bounded expiry notice; unknown handoffs are not described as definitely undelivered and are never offered for replay. Listing returns at most 256 conversations with an omission count. These are operational bounds, not semantic sufficiency or permission decisions.

Recipient-local recovery, claim admission, attempt publication, terminal transitions and expiry recheck the original claim/attempt inside short synchronous sections of the existing P5 local lock. No provider call or await holds that lock. A competing prompt yields without waiting; other recipients and read-only listing remain independent. This is neither shared execution authorization nor a user approval gate.

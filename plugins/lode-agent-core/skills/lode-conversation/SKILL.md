---
name: lode-conversation
description: Explain Lode work using available context, including material choices, meaningful progress, failures and results. Use for user-facing Lode conversations, not general writing or deciding execution and recovery authority.
---

# Lode conversation

Answer the question or give the useful outcome first, then the reason, change,
impact and uncertainty at the depth the user needs. Write in the conversation's
language and tone; no fixed persona, headings or report format. This Skill
explains results; it does not authorize execution, select a Session or supply
recovery direction.

## Which result field becomes which sentence

| Result field | Say | Do not say |
| --- | --- | --- |
| `presentation.mode: "quiet"` / successful entry, reuse or sync | Nothing about Lode; continue with the user's task. | "Lode restored your session successfully." |
| `presentation.mode: "notice"` + `attention.items` | The optional items only when they matter to the current request. | A to-do list the user must clear first. |
| `presentation.mode: "exception"` + `presentation.summary` | The summary in your own words, tied to the affected work. | The raw status code alone. |
| `ordinaryWorkBlocked: false` | Independent work continues; name only what waits. | "Work is blocked." |
| `recoveryDependentWorkBlocked: true` | Which recovery-dependent step waits and on what. | That the whole task stopped. |
| `userDecisionRequired: true` / `presentation.userActionRequired: true` | The concrete choice, its real alternatives and consequences. | An extra approval or questionnaire when it is `false`. |
| `nextHeadAction` / `nextAction` | What Lode does next, or the user's next step only when it is theirs. | Invented automatic resumption. |
| `currentProjectDirection` (goal, constraints, cancellations) | The current purpose and conditions; a later cancellation overrides an earlier approval. | A historical suggestion as the current request. |
| `workContext.records` / `recordExcerpts` | Saved reasons, alternatives, changes and results relevant to the question. | An excerpt as the full record or an empty history. |
| `workContext.todoContext` | Open, partial and waiting tasks as still open. | A task as done because time passed or the Host ended. |
| `coverage`, `omissions`, `partial` | That the view is partial and what was not covered. | "There is no other work." |
| `persisted: false` | That nothing was saved by this step. | That a read saved or recorded anything. |
| `authorityChanged: false` | Nothing, unless the user asks whether something was approved. | That a save, review or result granted permission. |
| `reasonCode` on a failure | The affected operation, the cause in plain words, and the next actor. | The code as the explanation. |
| `lode_conversation_send` `state` (`delivered`, `sent`, `queued`, `unknown`, `refused`, `unreachable`) | Exactly that state; `unknown` stays unknown. `queued` is handed over when the recipient's turn ends, by a later send through its live channel, or at its next prompt. | "Delivered" for `sent` or `queued`. |

## Distinctions to keep in the wording

- Facts, judgments and unknowns stay separate; keep negation, conditions and who
  owns a result. Local, published and installed are different; so are partial
  and complete.
- What the user requested, what the agent suggested and what changed outside the
  agreed scope are different. Do not hide an out-of-scope change in a summary.
- A completed review is not an accepted implementation; a retrieved explanation
  is not a verified effect; setup readiness is not task completion; an observed
  native activity state is not current execution or approval.
- Keep a still-valid agreement and a clear small request moving; explain a
  material choice so the user can decide.
- Link an existing deliverable or precise evidence when it helps. Do not create
  reports, saves or extra lookups to fill a format; this needs no separate
  rewriting pass, tool or reference chain.

<p>
  <img src="docs/assets/branding/lode-readme-wordmark.png" alt="Lode Agent Core" width="720">
</p>

# Lode

[English](README.md) | [한국어](README.ko.md) | [Documentation](docs/README.md) | [한국어 문서](docs/ko/README.md)

Keep the project's direction and the reasons behind changes across AI conversations.

Lode works with Codex, Claude Code and OpenCode. It restores saved work after compaction and prepares context for the task at hand.

[![Build](https://github.com/binary1215/lode/actions/workflows/go-worker-build-release.yml/badge.svg)](https://github.com/binary1215/lode/actions/workflows/go-worker-build-release.yml)
![Status](https://img.shields.io/badge/status-beta-blue)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![Runtime](https://img.shields.io/badge/runtime-Node.js%20%2B%20Go-00ADD8)

Beta. See the [changelog](CHANGELOG.md) and [installation guide](#install).
Local `.lode` records stay outside plugin packages.

[First request](#first-request) · [Install](#install) · [Daily use](#how-to-use-it) · [Recovery](#recovery)

<details>
<summary>All sections</summary>

[Why use it](#why-use-it) ·
[Who it is for](#who-it-is-for) ·
[How to use it](#how-to-use-it) ·
[Install](#install) ·
[Advanced use](#cli-automation-and-advanced-setup) ·
[Core model](#core-model) ·
[Graph](#graph-and-records) ·
[Capabilities](#capability-status) ·
[Docs](#documentation)

</details>

## What Lode Agent Core does

Lode records the agreed goal, the evidence behind changes and what remains to do. Later conversations can read those project records instead of relying on the old chat's memory.

Use your coding agent in Codex, Claude Code or a configured OpenCode workspace. There is no separate application to operate.

## Why use it

It is most useful when the project lasts longer than one conversation.

<a id="recovery"></a>

### Continue after compaction or session loss

Continue from the saved purpose, decisions, progress and next step. Recovery checks current constraints, and a newer user request wins over an older continuation. Lode saves checkpoints at meaningful changes or handoffs. Short investigations can retain selected reasons and uncertainty without a Run or checkpoint; neither needs a record on every turn.

Recovery covers recorded work direction, so unsaved conversation may be lost.
Supported Hooks can supply bounded prompt/final-response references as quoted
P5 context. They are neither a full transcript nor proof of current approval. Host support differs; see [Compaction recovery](docs/compaction-recovery.md), [Session recovery](docs/session-recovery.md) and [Session work context and Host support](docs/session-work-context.md).

### Give each task bounded, reviewable context

Describe the change. Lode reads the repository and selects the code and decision evidence it needs. When a context handoff is useful, the Context Compiler packs that material and reports exclusions and uncertainty. Keyword overlap does not prove relevance. You do not fill in evidence forms or manage budgets, and the compiler does not certify inclusion or semantic sufficiency. See [Context Compiler](docs/context-compiler.md).

### Review why a change happened

Git shows changed bytes. Lode also keeps the intended outcome, permitted scope, checks, review and next step. In managed work, a worker result cannot approve itself: independent review and the explicit decision stay separate. See [Execution Lineage](docs/execution-lineage.md) and [ChangeSets](docs/change-sets.md).

Inspect recorded reasons and cited source differences in the [recorded context view](docs/context-lineage.md), or ask Lode for a local, read-only [Graph Explorer snapshot](docs/graph-explorer.md). Citations and nearby nodes do not by themselves prove what caused a change.

### Connect product intent to code and tests

Trace reviewed product concepts to files, symbols and tests, then inspect suggested change impacts. Inferred meaning stays a candidate until the user accepts it. See [Feature mapping](docs/feature-mapping.md).

### Additional benefits

Optional workflows record Git and deployment evidence, product-specific observations, policy drift and measurements. Collected data does not become a product decision on its own, and a missing connector does not block ordinary coding. Built-in analytics and production-database connectors are not all provided. See [the capability list](#capability-status) and [documentation](#documentation).

## Who it is for

| If you… | Lode helps you… |
| --- | --- |
| Build a product over many AI conversations | Continue without re-explaining its direction each time. |
| Maintain a large or long-lived repository | Find the evidence needed for a change, including earlier decisions. |
| Coordinate teammates or several workers | Keep ownership, results and review distinct while integrating one outcome. |
| Switch between Codex, Claude Code and OpenCode | Keep project records independent of a provider conversation. |

For a one-off script or a short experiment where chat history is enough, you may not need it. Lode does not make model output automatically trustworthy, and a graph or database is not the authority for what the product should mean.

## Install

Requires Node.js 24 or newer. Use the commands for the client you already use.

Choose the path for your tool. The Codex and Claude Code packages include the conversation Skill, MCP server and verified native bundle for supported hosts. Only the matching host binary runs. OpenCode uses the project setup below; the CLI is optional for ordinary conversation.

[Install for Codex](#codex-git-marketplace) ·
[Install for Claude Code](#claude-code-git-marketplace) ·
[Set up OpenCode](#claude-code-and-opencode-project-projections)

Installation puts files in place. Project initialization/resume connects the
chosen repository; optional instruction linking preserves your existing text.
The agent checks Host tool loading separately. A package version or generated
file alone does not prove that the Host loaded it. You do not need another
doctor/setup step before starting ordinary work.

New installations use `lode-agent-core@lode-agent-plugin`. Already using HEAD? Keep updating your existing installation; no second plugin or project-record conversion is needed. The MCP server is named `lode`.

If Host permissions or automation name `mcp__head_core__...` or
`mcp__lode_core__...`, they do not migrate through the Core's `head_*` aliases.
After loading an update, inspect the Host's actual MCP tool list for server
`lode` and use those exact names when updating your own rules. Preserve the
existing configuration and running connection until you choose to change them;
a disk update alone does not reload the Host. See the
[MCP-name details](#mcp-name-details).

### Codex Git marketplace

Intermediate betas use verified marketplace publication; Git tags are reserved
for separately designated releases. See the [changelog and publication policy](CHANGELOG.md).

The repository is `binary1215/lode`. Its Lode marketplace is published on
`lode-codex-marketplace`; the former repository URL still redirects here.

```powershell
codex plugin marketplace add binary1215/lode --ref lode-codex-marketplace
codex plugin add lode-agent-core@lode-agent-plugin
```

Restart Codex after installation, start a new task so the installed Skill and
MCP server are loaded, then use [the first-request example](#first-request)
with your own task.

Installing the plugin does not initialize a project, contact GraphDB, choose
a model or approve Product Canon. Those operations still use the typed Core
boundary and require explicit user review where consequential.

### Claude Code Git marketplace

```powershell
claude plugin marketplace add binary1215/lode@lode-claude-marketplace
claude plugin install lode-agent-core@lode-agent-plugin
```

Restart Claude Code after installation so the installed Skill and `lode`
MCP server are loaded, then use [the first-request example](#first-request)
with your own task.

Claude Code copies the plugin into its versioned cache and locates the MCP
entry through `${CLAUDE_PLUGIN_ROOT}`. The source Core and existing Project
identities stay unchanged. Installation alone does not authorize project
changes, Product Canon review, GraphDB access or a model choice.

### Claude Code and OpenCode project projections

When using the user-scoped installation below, initialize the project with
`--runtime opencode` for OpenCode or `--runtime claude` for Claude Code. Use
`--runtime codex` for Codex; combine these only if you want multiple integrations.
Marketplace-installed Claude Code users can
request the same initialization through the bundled Skill. Lode creates
`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex, and `opencode.json` for
OpenCode only when those project files are absent. A verified plugin MCP
connection avoids creating a duplicate project `.mcp.json`; standalone Claude
initialization can create a missing file with a verified local launcher or exact
absolute package entry. Existing
files are preserved and generated manual-integration projections remain under
the selected root's `.lode/generated/` or existing `.head/generated/` directory.

OpenCode's local configuration names `node` and `{env:LODE_PLUGIN_ROOT}` rather than
an absolute Node binary or install path. Claude Code uses `${CLAUDE_PLUGIN_ROOT}`;
Codex uses the plugin-relative `.mcp.json` and `${PLUGIN_ROOT}` in hooks. Set
`LODE_PLUGIN_ROOT` to the Lode install when OpenCode is started without the
packaged plugin. The packaged plugin can repair an empty env-expanded path in
memory only when the original managed configuration hash and current package
identity match; it does not take over a user-owned or edited configuration. If the
installation path changes, install Lode on that PC and ask the agent to resume
the existing Project. At the same canonical Project path, this preserves Project
and Session IDs and the selected runtimes while updating the host installation
identity. Packaged launch paths use client placeholders; standalone Claude
launch paths can be machine-local.
A project-owned `opencode.json` or `opencode.jsonc` stays unchanged; the generated
copy remains available as a connection reference. Init, resume and status report
instructions and MCP separately: configured locally, missing, disabled,
conflicting, multiple entries or unknown. They reuse an existing sufficient
AGENTS connection or legacy server alias instead of asking for duplicates.
Ask the agent to connect only the missing items within your setup request,
preserving model, permissions, other servers and instruction order. A disabled
entry or conflicting launch needs its specific choice resolved only if you want
to change it. JSONC, unresolved Host variables and uninspectable files remain
unknown; Lode does not parse-and-rewrite them or block ordinary work. These are
local file observations, not proof that the running OpenCode Host loaded them.

If you move or copy the complete Project folder, explicitly resume it at the new
path. Lode verifies the retained owner and preserves Project/Session IDs and
historical records; a status read alone does not adopt the new location. This
does not transfer a native Host binding or replay execution. See
[Session recovery](docs/session-recovery.md). Check the running Host's MCP tool
loading separately.

If you choose instruction linking during setup, Lode can append a small block
to an existing instruction file once, preserving its original content. Claude
Code uses its instruction-file imports; Codex receives a directive to read the
project instructions. Declining leaves the file unchanged and does not block
your task or trigger another setup offer. See the installation guidance for
your Host; generated instructions alone do not prove that a running Host read them.

After initialization, start `claude` or `opencode` in the project. Follow the
Host’s approval policy for the selected MCP connection. An existing verified
plugin connection does not require a duplicate project server. The
runtime-native instruction/config files are projections; the selected `.lode/`
or existing `.head/` remains the single canonical Project root.

### User-scoped CLI

<details>
<summary>Show the optional user-scoped CLI installation</summary>

Supported runtime: Node.js 24 or newer; CI uses Node.js 24.18.0. You also need
either Git or a downloaded source archive. Git inside the target project, Go, GraphDB, and a provider
runtime are optional.

Windows PowerShell:

```powershell
git clone https://github.com/binary1215/lode.git lode
Set-Location .\lode
.\scripts\install.ps1 --native auto --project C:\path\to\project --runtime codex

lode-agent --version
```

macOS or Linux:

```bash
git clone https://github.com/binary1215/lode.git lode
cd lode
./scripts/install.sh --native auto --project /path/to/project --runtime codex

lode-agent --version
```

The installer stages a content-verified release in the current user's data
directory and writes launchers to `~/.local/bin`. It does not edit a shell
profile, a Codex cache, remote GraphDB, or an existing project before the
explicit `--project` initialization step.
The example selects Codex only; replace `codex` with `claude` or `opencode` for
that client. `--version` identifies the executing CLI, not the running Host's
loaded tools. Use existing status/doctor diagnostics only when needed.

</details>

<details>
<summary id="mcp-name-details">Already using HEAD? Installation identity and MCP-name details</summary>

New Lode installations use `lode-agent-core@lode-agent-plugin`, `lode_*` and Lode Skill names. Existing `codex-marketplace` and `claude-marketplace` addresses keep `head-agent-core@head-agent-plugin`, `head_*` and their existing Skill names. Each package registers one `lode` server and lists one tool vocabulary; both run the same implementation. Keep the marketplace you already use rather than installing both.

For an existing HEAD installation, continue with its usual update commands:

```powershell
codex plugin marketplace upgrade head-agent-plugin
codex plugin add head-agent-core@head-agent-plugin
```

```powershell
claude plugin marketplace update head-agent-plugin
claude plugin update head-agent-core@head-agent-plugin
```

Existing `.head/` records, IDs and selected Session stay intact; new projects use `.lode/`. Known operation aliases are not redirects for the Host-owned `mcp__head_core__...` or `mcp__lode_core__...` names. A disk update does not reload a running Host. Existing user-owned configuration is preserved, and generated alternatives use the new server name. Historical packages retain their exact bytes and namespace for verified rollback.

</details>

<a id="first-request"></a>

## Your first request

After [installing and loading the plugin](#install), open your project and include the real task in your first request. There is no separate setup conversation.

```text
Use Lode Agent Core for this project. Resume its existing state if one exists;
otherwise initialize the Core. Then find the cause of this login failure and fix it.
```

Replace the login failure with your own task. Lode continues it after initialization and verified recovery; you can keep asking for work in the same conversation.

<details>
<summary>Not installed? Ask your agent to help</summary>

Not installed yet? Give your coding agent this README and ask:

```text
Install Lode for Codex using its existing official installation path. Reuse a
valid installation and preserve my project instructions and current connections.
Do the steps you are allowed to perform; tell me only what needs my action.
Then use it in this project to investigate the login failure.
```

Replace Codex and the task with your client and goal. This starts from the
README even without an installed Skill. The agent performs the authorized
steps it can, checks the results, and continues your task. You may still need
to approve Host access, log in or restart the app yourself. The agent does not
restart it for you.

</details>

## How to use it

Start with [the first-request example](#first-request). Describe the outcome you want, then work in ordinary language.

```text
Prepare only the code and decision evidence needed for this change, then proceed.
```

```text
Keep one overall plan and use parallel workers only for the independent parts.
```

Lode normally works directly. When delegation helps, it gives the current tool's workers a clear scope, checks their results and combines them. If the tool cannot delegate, Lode continues directly or sequentially. Ordinary delegation does not require a managed Run, worker registry or extra approval.

You can also ask:

| Need | Example request |
| --- | --- |
| Resume remaining work | “Continue from the saved Todo and tell me what is still open.” |
| Keep the plan current | “Combine the implementation and review results, then adjust the next step for what we learned.” |
| Understand a change | “Show the recorded reason and the before/after source for this change.” |

These are ordinary requests. They add no save form, required review ceremony or new approval step.

### Separate conversations, shared direction

Independent tasks can keep separate work Sessions while sharing the project goal and current constraints. Starting a new conversation preserves other tasks' progress. You do not maintain Session IDs or routing forms. See [Graph discovery and independent Sessions](docs/graph-discovery.md).

After compaction or provider replacement, conversation entry checks the available saved work direction. You do not need to request recovery or supply a checkpoint ID.

Recovery uses saved records and does not guarantee preservation of the full unsaved conversation. Supported Hooks may supply bounded prompt/final-response references as quoted context. Host delivery and managed continuation have different support limits; see [Session work context and Host support](docs/session-work-context.md) and [capability status](#capability-status).

You do not write JSON, operate GraphDB, choose a token tier or decide which MCP call to make. Lode asks when a decision belongs to you: for example, approving product meaning, resolving an ambiguous scope, or allowing a consequential external change. Ordinary investigation and small authorized fixes stay ordinary work.

## Capability status

These labels describe the source distribution. They do not certify that a particular installed Host or live model has been tested. Saved-context delivery does not guarantee full unsaved-conversation preservation or managed automatic continuation; bounded references from supported Hooks remain quoted context.

<details>
<summary>Implemented, experimental and unshipped capabilities</summary>

- Available: implemented in the current source distribution;
- Experimental: implemented behind an explicit or limited activation path;
- Planned: accepted direction but not shipped;
- Deferred: intentionally outside the current milestone.

| Area | Capability | Status |
| --- | --- | --- |
| Project | initialization, Source Scope, review-gated Product Canon | Available |
| Knowledge | graph-first bounded discovery with source fallback, World Model, incremental refresh, optional Context Capsules | Available |
| Sessions | request-local logical Sessions and current common direction with exact-basis updates | Available |
| Sessions | supported exact Claude/OpenCode child state writes protected by default; Codex protection is opt-in | Experimental |
| Lineage | Runs, ResultPackets, Fresh Lode review, P2 Session and conversation-entry recovery | Available |
| Host lifecycle | provider-neutral compaction and at-most-once continuation contract, requiring a trusted Host adapter | Experimental |
| Host context | packaged Claude Code and Codex SessionStart delivery, including compact | Available |
| Host context | packaged OpenCode V1 per-model-request delivery, including summary and ordinary requests; not a post-compaction event | Available |
| Host context | bounded non-authoritative user-prompt reference after compact and clear for Claude Code, Codex, and OpenCode | Available |
| Runtime | Claude Code, Codex, and OpenCode one-shot Session/Run execution | Available |
| Runtime evidence | deterministic three-runtime fixtures and local CLI capability probes | Available |
| Runtime evidence | Claude Code live model-call conformance | Experimental |
| Release evidence | provider-neutral Git ref, deployment-result, and release observations | Available |
| Delivery evidence | provider-neutral per-environment/target applied, failed, and rollback history with exact optional source-revision links | Available |
| Common observations | reuse-first exact evidence preparation plus paged Host source discovery and opaque-ID collection | Available |
| Product policy | schema-v2 Policy proposal, exact application and semantic references, user review, evidence-currentness diagnostics, revision and retirement lineage | Available |
| Measurement | versioned metric definitions, exact observations, condition-aware comparison, non-causal assessment and bounded lineage | Available |
| Workers | bounded dispatch, wait, result, review, integration | Available |
| Coordination | ordinary Host delegation and optional exact-endpoint attachment | Available |
| Projection | local graph and Markdown | Available |
| Projection | ArcadeDB | Experimental |
| Distribution | user-scoped install, native delivery, rollback, safe removal | Available |
| Distribution | verified Git-backed Codex marketplace | Available |
| Distribution | verified Git-backed Claude Code marketplace | Available |
| Distribution | portable Claude Code, Codex, and OpenCode MCP launch paths | Available |
| Distribution | OpenAI universal plugin directory | Planned |
| Runtime | general provider-session resume and streaming | Deferred |
| Documents | Obsidian and Notion adapters | Deferred |

For exact claims and acceptance evidence, use the subsystem documents and source
verification rather than inferring capability from this summary.

</details>

## Documentation

| When you need to… | Read |
| --- | --- |
| Start work or install | [First request](#first-request), [Install](#install) |
| Continue saved work | [Recovery](#recovery), [Host support](docs/session-work-context.md) |
| Inspect context or recorded reasons | [Context Compiler](docs/context-compiler.md), [Graph Explorer](docs/graph-explorer.md) |
| Automate or integrate | [CLI](#cli-automation-and-advanced-setup), [Runtime adapters](docs/runtime-adapters.md) |

For changes and sensitive findings, see [Contributing](CONTRIBUTING.md) and
[Security](SECURITY.md). Neither document grants deployment or publishing permission.

Browse the [complete English documentation index](docs/README.md) or the
[complete Korean documentation index](docs/ko/README.md). Every public English
subsystem document has a Korean counterpart; code, command names, protocol
identifiers, and artifact field names remain unchanged across languages.

<details>
<summary>Subsystem guides</summary>

- [Recovery, Session selection and World freshness](docs/recovery-state-separation.md): distinguish saved direction from Session routing and derived World state;
- [Architecture](docs/architecture.md): the provider-neutral composition;
- [Authority planes](docs/authority-plane-contract.md): the executable
  Graph/record and non-amplification contract;
- [Onboarding](docs/onboarding.md): Lode semantic proposals, Core verification, and explicit review;
- [Context Compiler](docs/context-compiler.md): reproducible task context;
- [Work artifact storage](docs/artifact-storage.md): where to save evidence without extra ceremony.
- [Execution Lineage](docs/execution-lineage.md): plans, contracts, results,
  review, and recovery;
- [World Model](docs/world-model.md): source evidence and graph construction;
- [Runtime adapters](docs/runtime-adapters.md): capability, invocation, and
  process ownership;
- [Performance fast path](docs/performance-fast-path-design.md): optimization
  without semantic or authority shortcuts.

Additional references:

- [Product Model](docs/product-model.md)
- [Product Operating Loop](docs/product-operating-loop.md)
- [Release observation](docs/release-observation.md)
- [Common Observation contract](docs/observation-adapters.md)
- [Delivery state observation](docs/delivery-observation.md)
- [Non-blocking Conformance reconciliation](docs/conformance-reconciliation.md)
- [Incremental refresh](docs/incremental-refresh.md)
- [Compaction recovery](docs/compaction-recovery.md)
- [Session recovery](docs/session-recovery.md)
- [Ordinary Host delegation and optional attachment](docs/role-coordination.md)
- [Graph projection adapter](docs/graph-projection-adapter.md)
- [Document projection adapter](docs/document-projection-adapter.md)
- [Codex marketplace distribution](docs/codex-marketplace.md)
- [Claude Code marketplace distribution](docs/claude-marketplace.md)

Installed behavior is governed by these runtime contracts, the target project's
user-owned Canon, current Session/Run recovery state, and explicit
ReviewDecisions. Repository-development history, benchmark fixtures, and
maintainer milestones are evidence about the plugin; they are not instructions
for a project using it.

</details>

## CLI, automation, and advanced setup

<a id="conversational-context-preparation-and-preview"></a>
<a id="conversation-first-path"></a>
<a id="optional-product-profile-cli-path"></a>
<a id="source-scope"></a>

Use the [Core command reference](docs/README.md#command-reference).

For task-context examples, see [Context preparation](docs/context-compiler.md#context-examples). Optional Product setup is in [onboarding examples](docs/onboarding.md#product-cli-examples).

## Core model

<a id="architecture-at-a-glance"></a>
<a id="lode-judgment-with-reproducible-selected-context"></a>
<a id="execution-and-recovery"></a>
<a id="product-learning"></a>

Read about [authority, context and recovery](docs/architecture.md#detailed-core-model).

## Graph and records

<a id="graph-versus-record"></a>
<a id="query-the-graph"></a>

Explore [recorded context, snapshots and graph queries](docs/context-lineage.md#graph-and-record-examples).

## Runtime and coordination

See [workers, adapters and runtime attachment](docs/architecture.md#runtime-coordination-reference).

## Optional GraphDB

See [optional ArcadeDB configuration](docs/architecture.md#optional-graphdb-reference).

## Installation lifecycle

Before a shared Project writes physical schema-2 snapshots, update every reader
that will use them. Beta.69 and earlier reject these roots without rewriting them;
new readers still read retained older formats in place. Updating plugin files
does not reload an existing Host or MCP connection. See [storage compatibility](docs/snapshot-storage.md).

<details>
<summary>Native delivery, upgrade and removal</summary>

### Native packages

User-scoped install and upgrade default to `--native auto`. The installer selects
the exact version and platform package, verifies release checksum, archive paths,
build metadata, and native manifests, then includes the binaries in the release
identity. Use `--native off` for JavaScript-only installation or
`--native required` when fallback is unacceptable.

Codex and Claude marketplace snapshots carry the same verified packages for all
five supported targets, so those installs do not need a runtime download. A
missing target, mixed build commit, or manifest/digest mismatch blocks
marketplace publication.

Native components have separate contracts for authority-free computation, owned
process supervision, and read-only ArcadeDB batching. Installing one never
changes Product Canon, graph identity, review authority, or lineage.

### Status, upgrade, rollback, and removal

Run lifecycle commands from the newly downloaded source tree:

```powershell
node .\scripts\distribution.mjs upgrade
node .\scripts\distribution.mjs status
node .\scripts\distribution.mjs rollback
node .\scripts\distribution.mjs uninstall
```

Upgrade stages and verifies an immutable release before replacing the active
pointer. Normal removal deletes launchers and the active pointer but preserves
verified releases for recovery. `uninstall --purge` also removes the user-scoped
release store. Neither form traverses or deletes project `.lode` state, Git data,
generated project documents, or GraphDB data.

Provider configuration and authentication remain owned by Claude Code, Codex,
or OpenCode. Lode passes only the exact authorized `provider/model` plus an
ephemeral permission/privacy overlay; it does not install provider presets,
copy credentials, or rewrite endpoints.

</details>

## Design principles

Read the [design principles](docs/architecture.md#design-principles-reference).

## Verify from source

See [source verification and evidence limits](docs/verification-evidence.md#source-verification).

## Status and licensing

Lode Agent Core Plugin is beta software: the provider-neutral constitutional
Core, recovery, Context Compiler, execution lineage, local projections, bounded
workers, and verified Codex/Claude distribution are ready for broader testing.
Capabilities marked Experimental, Planned, or Deferred above remain outside
that beta claim.

This project is released under the [MIT License](LICENSE).
Native binaries also carry [Go runtime and standard-library notices](native/GO-NOTICES.txt).

# Codex marketplace distribution

Before changing this distribution plane, read [`architecture.md`](architecture.md)
and verify that installation remains a projection of the same provider-neutral
Core rather than a new identity or authority plane.

## Purpose

The source repository remains a directly runnable plugin root. CI assembles a
separate Git marketplace snapshot only after the integrated contract suite and
all five native build targets pass. This avoids moving or duplicating the
authoritative source layout merely to satisfy a distribution catalog layout.

The default Lode snapshot on `lode-codex-marketplace` contains exactly:

```text
.agents/plugins/marketplace.json
.gitattributes
.lode-agent-marketplace-generated.json
plugins/lode-agent-core/<verified distribution files>
```

The plugin directory is built from the same allowlisted file set used by the
immutable user distribution. It excludes `.git`, `test`, `node_modules`, local
developer `dist`, temporary trees, and caches. CI then assembles the five matrix
artifacts into one verified `dist/` bundle. Every target must match the plugin
version and source commit and must pass its worker, supervisor, and read-only
ArcadeDB bridge manifest checks; a missing, extra, mixed-commit, or digest-invalid
target stops publication. `distribution-manifest.json` hashes every source and
native file, and the branch marker binds the marketplace name, plugin
name/version, distribution release ID, source repository, and exact source
commit into a content-derived snapshot ID.

The generated `.gitattributes` contains `* -text`. It is itself part of the
strictly verified tree and prevents Git from rewriting LF/CRLF bytes on a
different operating system, so the distribution manifest remains portable
rather than validating only on the Linux publisher.

The source branch separately enforces `text=auto eol=lf`. This makes a fresh
Windows, macOS, or Linux source checkout feed the same text bytes into direct
installation and marketplace assembly; the generated branch then freezes those
already normalized bytes with `* -text`.

## Installation

```powershell
codex plugin marketplace add binary1215/lode --ref lode-codex-marketplace
codex plugin add lode-agent-core@lode-agent-plugin
```

The server name is `lode`, including in the HEAD compatibility package. Host
permissions and automation bound to `mcp__head_core__...` or
`mcp__lode_core__...` do not migrate through internal `head_*` operation aliases.
When you choose to load an update, inspect the Host's connected MCP tool list
and use the exact names it exposes for `lode` when updating your own rules.
Preserve existing configuration and the running connection until then. Do not
rewrite a cached plugin or historical rollback package to rename its server;
an on-disk update alone does not reload the Host.

Start a new Codex task after installation. Normal use begins through the
bundled `lode-agent-core` Skill, which calls the typed `lode` MCP
operations. Installation alone does not create `.lode/` or `.head/`, infer or approve
Features, contact GraphDB, or alter project files.

The marketplace snapshot already carries Windows x64, Linux x64/arm64, and
macOS x64/arm64 native packages. Runtime selection uses only the current host's
integrity-verified directory and needs no install-time download. Native
availability does not change authority: production repository scanning remains
on the JavaScript reference path until its native candidate earns activation by
benchmark and conformance evidence.

## Upgrade and removal

Refresh the generated Git snapshot, then reinstall the plugin from the same
marketplace:

```powershell
codex plugin marketplace upgrade lode-agent-plugin
codex plugin add lode-agent-core@lode-agent-plugin
```

Remove the plugin and optionally its marketplace source:

```powershell
codex plugin remove lode-agent-core@lode-agent-plugin
codex plugin marketplace remove lode-agent-plugin
```

Codex plugin removal affects the Codex plugin cache/configuration. It does not
delete project `.head` artifacts, the user-scoped `head-agent` distribution,
Git history, Markdown projections, or GraphDB data.

## Generated-branch ownership

CI verifies each existing `lode-codex-marketplace` or `codex-marketplace` branch
against its own exact marketplace identity before replacing it. When owned, replacement
uses an exact expected-commit `--force-with-lease`; concurrent or unowned branch
changes fail rather than being overwritten. The generated branch never feeds
plugin identity, Product Canon, GraphSnapshot, Context Capsule, or Execution
Lineage. Historical ownership exceptions apply only to the HEAD compatibility
branch, never to the new Lode address.

Local verification:

```powershell
npm run verify:codex-marketplace
node scripts/build-codex-marketplace.mjs --output C:\temporary\lode-agent-marketplace
node scripts/verify-codex-marketplace.mjs --root C:\temporary\lode-agent-marketplace
```

CI supplies `--native-root` to the builder and `--require-native` to the
verifier. Local source-only verification intentionally remains available for
development; it must not be used as evidence that a publishable native snapshot
was assembled.

## Public-directory boundary

This Git marketplace is an installable authoring/team distribution source. It
is not a claim that the plugin has passed OpenAI universal plugin-directory
review. Public submission requires publisher identity, listing/support/privacy
materials, policy attestations, and an external review. That consequential
publisher action remains user-owned and is not performed by CI.

## Canonical and compatibility compositions

The canonical source artifact advertises plugin `lode-agent-core`, server `lode`,
tools `lode_*`, and Skills `lode-agent-core`, `lode-agent-onboarding` and
`lode-conversation`. The existing `codex-marketplace` branch continues to publish
the compatibility carrier: plugin `head-agent-core@head-agent-plugin`, server `lode`,
tools `head_*`, and Skills `head-agent-core`, `head-agent-onboarding` and
`head-conversation`. Both use the same Lode implementation and guards; an artifact
advertises only its own single vocabulary. Source packaging does not prove publication,
installation or loaded Host behavior. Each catalog contains one plugin; there is
no automatic identity conversion or dual registration.

### Existing HEAD installations

Keep the original `binary1215/lode --ref codex-marketplace` marketplace address
and update commands. No marketplace re-registration, Lode reinstall or second
plugin is needed:

```powershell
codex plugin marketplace upgrade head-agent-plugin
codex plugin add head-agent-core@head-agent-plugin
```

Removal still uses `codex plugin remove head-agent-core@head-agent-plugin` and
`codex plugin marketplace remove head-agent-plugin`. The compatibility snapshot
keeps `.head-agent-marketplace-generated.json` and `plugins/head-agent-core/`;
historical snapshots and rollback retain their original identities and bytes.

Fresh initialization uses `.lode/`. Existing `.head/` Projects preserve their root,
identity, records, selected Session and operational ownership; no manual conversion
or second canonical store is required.

Both artifacts register and initialize the MCP server as `lode`. Core recognizes
finite `head_*` and `lode_*` operation aliases, while each artifact lists only its
own tools. Those aliases do not redirect the Host-owned `mcp__head_core__...` or
`mcp__lode_core__...` namespace. An older running Host keeps its loaded connection;
an update on disk is not a reload or proof of the new Host tool inventory.
Existing user-owned `.mcp.json` and `opencode.json` are preserved; generated
alternatives use the new server name. Historical release verification and rollback
retain the original manifest, exact namespace, records and checksums rather than
rewriting an old package.

### Publication versions

Each Codex/Claude and Lode/HEAD marketplace identity is checked separately before
publication. A changed distributed source or native build recipe needs a higher
version; downgrades and conflicting existing version tags are refused. On an
equivalent same-version retry, publication is skipped: the existing branch, marker
and payload bytes stay unchanged, even if a rebuild embeds a new source commit.
This compares recorded source/build inputs, not native executable equivalence.
Missing same-version equivalence proof stops publication, not normal plugin use.
Verified older snapshots remain valid and can advance to a higher version without
reconstructing their historical build recipe. Complete release retries also skip
all writes; partial or unverifiable releases require explicit repair or a new
version. Existing tags and release assets are never intentionally replaced.


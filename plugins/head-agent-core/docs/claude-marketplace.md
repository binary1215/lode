# Claude Code marketplace distribution

Before changing this distribution plane, read [`architecture.md`](architecture.md)
and [`authority-plane-contract.md`](authority-plane-contract.md). Claude Code
packaging is a projection of the provider-neutral Core, not a new semantic or
authority plane.

## Purpose

CI creates a generated `lode-claude-marketplace` branch after the integrated
contract suite and native build matrix pass. The source repository remains the
directly runnable Core; Claude-specific catalog and cache-path details do not
enter `.head/`, Product Canon, Session/Run lineage, or runtime authorization.

The default Lode snapshot contains exactly:

```text
.claude-plugin/marketplace.json
.gitattributes
.lode-agent-claude-marketplace-generated.json
plugins/lode-agent-core/.claude-plugin/plugin.json
plugins/lode-agent-core/.lode-source-distribution-manifest.json
plugins/lode-agent-core/<allowlisted distribution files>
```

The builder first stages and verifies the same immutable user-distribution
allowlist used by the Codex marketplace. It excludes Git metadata, tests,
development-only goals and fixtures, local build output, temporary trees,
caches, and credentials. CI then overlays the exact five verified build-matrix
targets. Each target must share the plugin version and source commit and pass
the worker, supervisor, and read-only ArcadeDB bridge integrity contracts. The
original verified manifest, including every native byte, is retained as
`.lode-source-distribution-manifest.json` to bind source release lineage.

Claude Code copies installed plugins to a versioned cache, so relative process
paths would resolve against the caller rather than the plugin. Only in the
generated Claude snapshot, `.mcp.json` is projected to:

```json
{
  "mcpServers": {
    "lode": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-plugin-server.mjs"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}"
    }
  }
}
```

All unprojected files must remain byte-identical to the verified source
distribution. The generated marker binds the marketplace and plugin identities,
source release, repository, exact source commit, and a digest over every final
projected byte. The verifier rejects extra files or directories, symlinks, path
escape, source-file drift, projection drift, and identity mismatch.

## Installation

Requirements: Claude Code and Node.js 24 or newer.

```powershell
claude plugin marketplace add binary1215/lode@lode-claude-marketplace
claude plugin install lode-agent-core@lode-agent-plugin
```

The server name is `lode`, including in the HEAD compatibility package. Host
permissions and automation bound to `mcp__head_core__...` or
`mcp__lode_core__...` do not migrate through internal `head_*` operation aliases.
When you choose to load an update, inspect the Host's connected MCP tool list
and use the exact names it exposes for `lode` when updating your own rules.
Preserve existing configuration and the running connection until then. Do not
rewrite a cached plugin or historical rollback package to rename its server;
an on-disk update alone does not reload the Host.

Start a new Claude Code session after installation. Normal use begins through
the bundled `lode-agent-core` Skill and typed `lode` MCP operations.
Installation alone does not create `.lode/` or `.head/`, modify a project, contact GraphDB,
choose a provider/model, approve Product Canon, or create a ReviewDecision.

The versioned Claude cache receives all five platform packages, but the runtime
selects only its exact current-host directory. No installation-time release
download is required. Native components remain an authority-free compute and
transport projection; the JavaScript Core still owns semantic validation,
lineage, and every consequential gate.

## Upgrade and removal

```powershell
claude plugin marketplace update lode-agent-plugin
claude plugin update lode-agent-core@lode-agent-plugin
```

```powershell
claude plugin uninstall lode-agent-core@lode-agent-plugin
claude plugin marketplace remove lode-agent-plugin
```

Removing the plugin does not delete project-owned or Lode-managed project state.
Project `.head/` removal remains a separate explicit user action.

## Publication ownership

CI verifies each existing `lode-claude-marketplace` or `claude-marketplace` branch
against its own exact marketplace identity before replacing it. A
verified branch is published from an orphan commit using force-with-lease against
the exact prior tip. Missing ownership evidence, concurrent branch movement, or
any invalid prior snapshot stops publication. Historical ownership exceptions
apply only to the HEAD compatibility branch, never to the new Lode address.

The generated `.gitattributes` is exactly `* -text`, preventing checkout-time
newline rewriting from invalidating byte identities across operating systems.

## Verification

```powershell
npm run verify:distribution
npm run verify:claude-marketplace
node scripts/build-claude-marketplace.mjs --output C:\temporary\lode-agent-claude-marketplace
claude plugin validate C:\temporary\lode-agent-claude-marketplace
```

The publisher additionally builds with `--native-root` and verifies with
`--require-native`; a source-only local snapshot cannot satisfy that publish
gate.

For an isolated install test, set `CLAUDE_CONFIG_DIR` to a new temporary
directory before adding the local generated marketplace. This keeps marketplace,
cache, and plugin state outside the user's normal Claude configuration.

This repository is not an official Anthropic marketplace. It is a Git-hosted
third-party Claude Code marketplace distributed under the [MIT License](../LICENSE).

## Canonical and compatibility compositions

The canonical source artifact advertises plugin `lode-agent-core`, server `lode`,
tools `lode_*`, and Skills `lode-agent-core`, `lode-agent-onboarding` and
`lode-conversation`. The existing `claude-marketplace` branch continues to publish
the compatibility carrier: plugin `head-agent-core@head-agent-plugin`, server `lode`,
tools `head_*`, and Skills `head-agent-core`, `head-agent-onboarding` and
`head-conversation`. Both use the same Lode implementation and guards; an artifact
advertises only its own single vocabulary. Source packaging does not prove publication,
installation or loaded Host behavior. Each catalog contains one plugin; there is
no automatic identity conversion or dual registration.

### Existing HEAD installations

Keep the original `binary1215/lode@claude-marketplace` marketplace address and
update commands. No marketplace re-registration, Lode reinstall or second plugin
is needed:

```powershell
claude plugin marketplace update head-agent-plugin
claude plugin update head-agent-core@head-agent-plugin
```

Removal still uses `claude plugin uninstall head-agent-core@head-agent-plugin` and
`claude plugin marketplace remove head-agent-plugin`. The compatibility snapshot
keeps `.head-agent-claude-marketplace-generated.json`, `plugins/head-agent-core/`
and `.head-source-distribution-manifest.json`; historical snapshots and rollback
retain their original identities and bytes.

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


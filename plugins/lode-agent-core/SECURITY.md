# Security

[한국어](SECURITY.ko.md)

## Reporting sensitive findings

Use [GitHub private vulnerability reporting](https://github.com/binary1215/lode/security/advisories/new)
for sensitive findings. Private vulnerability reporting is enabled for this
repository; sign in to GitHub to submit the report. No separate email address
is declared here.
Do not publish credentials, OAuth tokens, private repository contents, original
work records or exploitable details in public issues or exported reports.
No response SLA or security-support window is declared here.

For a non-sensitive reproduction, use a synthetic repository and include the
source/package version, the affected operation, expected and actual behavior,
and redacted evidence. Distinguish installed files from the active Host/MCP
connection. A beta label or successful CI run is not a security guarantee.

## Existing boundaries

- Graphs, indexes and Explorer HTML are derived views, not approval, execution
  permission or recovery direction. See [authority planes](docs/authority-plane-contract.md).
- Exported originals may contain sensitive content. Explorer's share mode omits
  generated machine metadata only; it does not anonymize originals. See
  [Graph Explorer](docs/graph-explorer.md).
- Preserve exact source digests, path checks, bounded reads and native process
  ownership checks. Do not bypass a denied action through another tool or weaken
  checks to make a reproduction pass.
- Marketplace publication, verified package files and an actually loaded Host
  are separate observations. Follow the [installation instructions](README.md#install).

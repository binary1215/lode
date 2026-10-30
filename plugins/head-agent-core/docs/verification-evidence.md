# What verification proves

Core tests check exact identities, current-state validation, permitted transitions,
replay, and isolation of unrelated work. Passing tests do not disprove an untested
counterexample. Reproduced failures need behavioral regressions, including
competing processes and interrupted writes at authority and consumption boundaries.

The annotated Context test supplies a known graph anchor. It measures preservation
of supplied evidence and exclusion of unrelated carriers. It does not measure
whether provider Lode discovers that anchor, reads the source body, or correctly
implements the task. Newcomer and conversational verifiers drive public CLI/MCP
operations with fixtures; they do not establish natural-language task success.

## Local diagnostics

Run the optional diagnostic from the source checkout:

```powershell
npm run measure:context-diagnostics
npm run measure:context-diagnostics -- --project C:\path\to\project --task "Inspect the requested change" --iterations 5
```

The report separates read-only, mutation, and missing hints. Catalog size is UTF-8
serialized bytes, not model token cost. Static import cycles indicate coupling,
not an observed runtime failure.

With a project and task, it measures the first preview and repeated previews in
one process. It does not flush OS caches, so the first call is not an OS cold-cache
measurement. Filesystem API read bytes are not physical disk I/O. Measurements
never enter Capsule identity, evidence selection, approval, or recovery. The
command does not initialize a project, refresh World, save a Capsule, or call a
provider. It does not print task text, source bodies, or Observation payloads.

## Live task evaluation

Use held-out tasks with hidden expected evidence and acceptance criteria. Compare
ordinary agent use and Lode with the same provider/model, repository revision,
task, permissions, and external dependencies. Do not supply expected anchors.
Evaluate task interpretation, evidence discovery, file reading, implementation,
and verification, including a controlled compaction or provider replacement case.

Record task success, missed required evidence, incorrect edits, unnecessary
questions and approvals, elapsed time, actual provider tokens, and retention of
user constraints after recovery. Repeat runs and separate environmental failures.
Mechanical coverage, package installation, and tool-call success cannot establish
these outcomes. Current fixtures do not prove general superiority or task success.

## CI and publication

Directory-level triggers cover source, tests, native code, docs, and distribution
inputs. The complete JavaScript suite is an independent prerequisite for release
and both marketplaces. Cross-builds prepare target bytes; Windows and macOS jobs
separately execute installation, native health, owned-process cleanup, rollback,
and uninstall smoke.

CI results, local Windows results, cross-builds, actual marketplace installation,
and live provider behavior are separate evidence. A configured job is not a
passed run. Missing fixtures or opt-in requirements in optional native or
live-provider lanes must be disclosed, not counted as passed.

<a id="source-verification"></a>

## Verify from source

Core verifies the exact target and permitted transition of a decision supplied
by a trusted local caller. The Host and Lode must convey the user's actual
approval; digests and confirmation flags do not authenticate a human.

Fixture tests establish reproducibility and transition behavior. They do not
establish Lode's evidence-discovery rate or end-to-end coding accuracy.
See [verification evidence and local diagnostics](verification-evidence.md).

```powershell
npm test
npm run verify:newcomer
npm run verify:distribution
npm run verify:codex-marketplace
npm run verify:claude-marketplace
```

Native sources additionally support `go test ./...` and `go vet ./...` from the
corresponding module directories. JavaScript remains the semantic reference;
native backends are advertised only after fixture-driven conformance and
integrity verification.

## Coverage computation comparison

The selected-fragment coverage index replaces repeated scans with per-render field and array-index buckets. It changes calculation cost, not retrieval, selected content, context bounds, authority or persistence. The baseline and candidate received the same originals and budgets.

Separate, overlapping evidence groups showed identical output: 24 pure delivery cases, 18 shipped startup-formatter cases on synthetic entries, 22 callback-trace cases and 40 independent fitter cases. Related regressions recorded 148 passes, no failures and one synthetic symlink skip because the local account lacked permission. These counts must not be added as distinct end-to-end scenarios.

At the 4,800-character synthetic pressure setting, the linked-judgment fitter took 784–914 ms in the baseline and 33–45 ms in the candidate; the Todo fitter took 707–792 ms and 26–33 ms. These are raw ranges from paired, alternating-order in-process runs, excluding module startup. They are not p95, whole-application latency or a universal speedup; full-body and short cases did not improve uniformly.

A group-first packing experiment lost a required condition, and graph interleaving lost a required citation despite improving another recall case. Both were rejected. Long omitted conditions and baseline retrieval quality remain unresolved. No installed Host, real provider/model, tokenizer or total-memory improvement was established.

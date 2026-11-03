# Contributing

[한국어](CONTRIBUTING.ko.md)

Keep changes tied to a concrete behavior or counterexample. Preserve existing
work, author credits, source identities and the distinction between evidence,
approval and execution. Avoid broad rewrites or new gates for ordinary work.

## Check a change

Use Node.js 24 or later, as declared in package.json, and a Go toolchain for
the native supervisor. `npm test` builds that verified fixture when
`LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT` is unset, then runs the suite.
Start with the affected tests; retain meaningful case names, failure assertions,
skip reasons and per-test temporary roots. Shared helpers must create fresh
mutable state per call. Do not replace process ownership tests with mocks.

The existing complete JavaScript regression and documentation checks are:

```text
npm test
npm run verify:docs
```

Select additional native, distribution or runtime checks according to the
affected contract. Preserve failed logs rather than repeating until a pass.
Record the tested source identity, command, actual result and remaining limits.
Clean up owned processes by exact identity, never by a shared process name.

## Describe what was verified

Keep English and Korean documentation aligned. Separate source/unit tests,
synthetic protocol tests, actual browser GUI, live provider behavior, publication,
installation and Host reload. A passing test or review does not imply the others.

Publishing a version requires its own authorization and the existing workflow;
do not hand-edit marketplace snapshots. Do not include local development goals,
private test data or credentials in a contribution. See [Security](SECURITY.md)
before reporting a sensitive finding and [the changelog](CHANGELOG.md) for the
publication policy.

// Skip ledger for scripts/run-tests.mjs.
//
// The default export is a node:test reporter. The runner adds it next to the
// TAP reporter, so the TAP stream on stdout is unchanged, and this reporter
// writes one JSON line per skipped, todo, timed-out or parent-cancelled test
// to its own destination file. The runner then checks those records against
// test/fixtures/skip-ledger.json:
//
//   R1  every skip carries a reason (no bare t.skip(), test.skip() or { skip: true });
//   R2  every reason starts with "<class>: " for a class the ledger declares;
//   R3  on Windows a "native-fixture" skip fails, because the runner supplies that fixture
//       (except a Windows test fixture the runner announced it could not supply without Go);
//   R4  in a full run, the skipped tests of each pinned class equal the ledger's list for
//       this operating system, and every skip of a bounded class is on its list (a listed
//       test that runs is fine); both compare as multisets, so a test that skips twice
//       must be listed twice; a difference fails and prints the tests that moved;
//   T   a todo test fails the run: node reports it as passing whatever it does;
//   H   in CI (runsInCi below), a "host-limit" skip fails the run: a CI runner must give
//       every test what it needs. On a developer machine host-limit skips are only counted.
//
// A run of selected files checks R1-R3, T and H.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LEDGER_FILE = path.join(root, "test", "fixtures", "skip-ledger.json");
const CLASS_PREFIX = /^([a-z][a-z-]*): \S/;

function relativeFile(file) {
  if (typeof file !== "string" || !file) return "(unknown file)";
  const absolute = file.startsWith("file:") ? fileURLToPath(file) : file;
  return path.relative(process.cwd(), absolute).split(path.sep).join("/");
}

export default async function* skipLedgerReporter(source) {
  const names = [];
  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === "test:start") {
      names.length = data.nesting;
      names[data.nesting] = data.name;
      continue;
    }
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    names.length = data.nesting;
    const test = [...names, data.name].join(" > ");
    const file = relativeFile(data.file);
    if (data.skip !== undefined && data.skip !== false) {
      yield JSON.stringify({ kind: "skip", file, test, reason: data.skip }) + "\n";
    }
    if (data.todo !== undefined && data.todo !== false) {
      yield JSON.stringify({ kind: "todo", file, test, passed: event.type === "test:pass" }) + "\n";
    }
    if (event.type !== "test:fail") continue;
    const error = data.details?.error;
    if (error?.failureType === "testTimeoutFailure" || error?.cause?.failureType === "testTimeoutFailure") {
      yield JSON.stringify({ kind: "timeout", file, test, message: String(error.message ?? error.cause?.message ?? "") }) + "\n";
    } else if (error?.failureType === "hookFailed" && /timed out after/.test(String(error.cause?.message ?? error.cause ?? ""))) {
      // A timed-out hook fails its test or suite with the timeout as a plain string cause.
      yield JSON.stringify({ kind: "timeout", file, test, message: `${error.message}: ${error.cause?.message ?? error.cause}` }) + "\n";
    } else if (error?.failureType === "cancelledByParent") {
      yield JSON.stringify({ kind: "cancelled", file, test }) + "\n";
    }
  }
}

// The one place that decides "in CI": CI=true. GitHub Actions sets it on every runner,
// as most CI services do, and a developer can set it to reproduce the CI result locally.
// GITHUB_ACTIONS would tie the rule to one service and could not be reproduced as plainly.
export function runsInCi(env = process.env) {
  return env.CI === "true";
}

export function readLedger(file = LEDGER_FILE) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function classify(reason, ledger) {
  if (typeof reason !== "string" || !reason.trim()) return { problem: "R1", detail: "skip has no reason" };
  const match = CLASS_PREFIX.exec(reason);
  if (!match) return { problem: "R2", detail: `reason does not start with "<class>: ": ${JSON.stringify(reason)}` };
  if (!Object.hasOwn(ledger.classes, match[1])) return { problem: "R2", detail: `undeclared class "${match[1]}": ${JSON.stringify(reason)}` };
  return { skipClass: match[1] };
}

function multisetDifference(left, right) {
  const remaining = new Map();
  for (const item of right) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  const result = [];
  for (const item of left) {
    const count = remaining.get(item) ?? 0;
    if (count > 0) remaining.set(item, count - 1);
    else result.push(item);
  }
  return result;
}

// Returns { problems: string[], summary: string[], observed } for one finished run.
// `unsupplied` names fixture variables the runner announced it could not supply;
// a native-fixture skip whose reason names one of them is reported, not failed.
export function checkSkips({ records, ledger, platform = process.platform, fullRun, unsupplied = [], ci = false }) {
  const problems = [];
  const observed = {};
  const counted = {};
  const listed = (skipClass) => ledger.classes[skipClass].pinned || ledger.classes[skipClass].bounded === true;
  for (const record of records.filter((entry) => entry.kind === "todo")) {
    problems.push(`T: ${record.file} > ${record.test}: todo test; node reports it as passing whatever it does. Make it pass or skip it with a classed reason.`);
  }
  for (const record of records.filter((entry) => entry.kind === "skip")) {
    const where = `${record.file} > ${record.test}`;
    const { problem, detail, skipClass } = classify(record.reason, ledger);
    if (problem) {
      problems.push(`${problem}: ${where}: ${detail}`);
      continue;
    }
    if (skipClass === "native-fixture" && unsupplied.some((name) => record.reason.includes(name))) {
      counted["native-fixture (not supplied)"] = (counted["native-fixture (not supplied)"] ?? 0) + 1;
      continue;
    }
    counted[skipClass] = (counted[skipClass] ?? 0) + 1;
    if (skipClass === "host-limit" && ci) {
      problems.push(`H: ${where}: host-limit skip in CI; the CI runner must give this test what it needs: ${record.reason}`);
    }
    if (skipClass === "native-fixture" && platform === "win32") {
      problems.push(`R3: ${where}: native-fixture skip on Windows; scripts/run-tests.mjs supplies that fixture, so its wiring broke: ${record.reason}`);
    }
    if (listed(skipClass)) (observed[skipClass] ??= []).push(`${record.file} > ${record.test}`);
  }
  for (const list of Object.values(observed)) list.sort();
  if (fullRun) {
    const pinned = ledger.skips?.[platform];
    if (!pinned) {
      problems.push(`R4: test/fixtures/skip-ledger.json has no entry for ${platform}.`);
    } else {
      for (const skipClass of Object.keys(ledger.classes).filter((name) => ledger.classes[name].bounded === true)) {
        const unlisted = multisetDifference(observed[skipClass] ?? [], pinned[skipClass] ?? []);
        if (!unlisted.length) continue;
        problems.push(
          [
            `R4: ${platform} "${skipClass}" skips not on the ledger's list (an upper bound): ${unlisted.length}.`,
            ...unlisted.map((name) => `  now skipped: ${name}`),
          ].join("\n"),
        );
      }
      for (const skipClass of Object.keys(ledger.classes).filter((name) => ledger.classes[name].pinned)) {
        const expected = pinned[skipClass] ?? [];
        const actual = observed[skipClass] ?? [];
        const added = multisetDifference(actual, expected);
        const removed = multisetDifference(expected, actual);
        if (!added.length && !removed.length) continue;
        problems.push(
          [
            `R4: ${platform} "${skipClass}" skips: ${actual.length} now, ${expected.length} pinned.`,
            ...added.map((name) => `  now skipped: ${name}`),
            ...removed.map((name) => `  no longer skipped: ${name}`),
          ].join("\n"),
        );
      }
    }
  }
  const summary = Object.keys(counted)
    .sort()
    .map((name) => `${name} ${counted[name]}`);
  return { problems, summary, observed };
}

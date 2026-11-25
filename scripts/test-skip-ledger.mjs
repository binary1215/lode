// Skip ledger for scripts/run-tests.mjs.
//
// The default export is a node:test reporter. The runner adds it next to the
// TAP reporter, so the TAP stream on stdout is unchanged, and this reporter
// writes one JSON line per skipped or timed-out test to its own destination
// file. The runner then checks those records against
// test/fixtures/skip-ledger.json:
//
//   R1  every skip carries a reason (no bare t.skip(), test.skip() or { skip: true });
//   R2  every reason starts with "<class>: " for a class the ledger declares;
//   R3  on Windows a "native-fixture" skip fails, because the runner supplies that fixture;
//   R4  in a full run, the skipped tests of each pinned class equal the ledger's list for
//       this operating system; a difference fails and prints the tests that moved.
//
// A run of selected files checks R1-R3 only.
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
    const error = data.details?.error;
    if (event.type === "test:fail" && (error?.failureType === "testTimeoutFailure" || error?.cause?.failureType === "testTimeoutFailure")) {
      yield JSON.stringify({ kind: "timeout", file, test, message: String(error.message ?? error.cause?.message ?? "") }) + "\n";
    }
  }
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
export function checkSkips({ records, ledger, platform = process.platform, fullRun }) {
  const problems = [];
  const observed = {};
  const counted = {};
  for (const record of records.filter((entry) => entry.kind === "skip")) {
    const where = `${record.file} > ${record.test}`;
    const { problem, detail, skipClass } = classify(record.reason, ledger);
    if (problem) {
      problems.push(`${problem}: ${where}: ${detail}`);
      continue;
    }
    counted[skipClass] = (counted[skipClass] ?? 0) + 1;
    if (skipClass === "native-fixture" && platform === "win32") {
      problems.push(`R3: ${where}: native-fixture skip on Windows; scripts/run-tests.mjs supplies that fixture, so its wiring broke: ${record.reason}`);
    }
    if (ledger.classes[skipClass].pinned) (observed[skipClass] ??= []).push(`${record.file} > ${record.test}`);
  }
  for (const list of Object.values(observed)) list.sort();
  if (fullRun) {
    const pinned = ledger.skips?.[platform];
    if (!pinned) {
      problems.push(`R4: test/fixtures/skip-ledger.json has no entry for ${platform}.`);
    } else {
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

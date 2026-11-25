import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ENVIRONMENT_NAME_PAIRS } from "../compat/head/public-names.mjs";
import { createProcessSupervisorManifest } from "../scripts/lib/runtime/runtime-process-supervisor.mjs";
import {
  NATIVE_FIXTURE_SETTINGS,
  fileEffectFixtureRoot,
  missingSettingsSkip,
  nativeFixtureSkip,
  settingNames,
  skipReason,
  supervisorFixtureRoot,
  testSetting,
  windowsNativeSkip,
} from "./helpers/native-fixtures.mjs";

const testRoot = import.meta.dirname;
const helperFile = path.join(testRoot, "helpers", "native-fixtures.mjs");
const names = Object.values(NATIVE_FIXTURE_SETTINGS).flatMap((canonical) => {
  const pair = ENVIRONMENT_NAME_PAIRS.find((item) => item.canonical === canonical);
  assert.ok(pair, `${canonical} has a compatibility pair`);
  return [pair.canonical, pair.legacy];
});
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sources(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "fixtures" && entry.name !== "node_modules") result.push(...sources(file));
    } else if (/\.(mjs|cjs|js)$/.test(entry.name)) result.push(file);
  }
  return result;
}

// A read is any member access of one of the names on any object (`.X`, `?.X`,
// `["X"]`), one of the names as a whole string literal that is not an object
// key (it can index an environment later), or the name destructured from an
// object. Allowed: object-literal keys, `delete <chain>.X`, an assignment
// target, and mentions inside longer text, comments or regex literals.
const quotes = ["'", '"', "`"];
function occurrenceIsRead(text, index, name) {
  const before = text.slice(Math.max(0, index - 200), index);
  let after = text.slice(index + name.length, index + name.length + 200);
  const quote = before.at(-1);
  const quoted = quotes.includes(quote) && after.startsWith(quote);
  const head = quoted ? before.slice(0, -1) : before;
  const indexed = quoted && /\[\s*$/.test(head) && /^.\s*\]/s.test(after);
  const member = !quoted && /(?<!\.)\.\s*$/.test(before);
  if (indexed) after = after.replace(/^.\s*\]/s, "");
  if (member || indexed) {
    const chain = indexed ? head.replace(/\[\s*$/, "") : before.replace(/\??\.\s*$/, "");
    const deleted = /\bdelete\s+[\w$.?[\]"'`]*$/.test(chain);
    const assigned = /^\s*=(?![=>])/.test(after);
    return !deleted && !assigned;
  }
  // A whole-name string literal is a read unless it is an object key.
  if (quoted) return !/^.\s*:/s.test(after);
  return false;
}
function directReads(text) {
  const found = [];
  for (const name of names) {
    const occurrences = [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_$])${escape(name)}(?![A-Za-z0-9_$])`, "g"))];
    const destructured = new RegExp(`\\{[^{}]*\\b${escape(name)}\\b[^{}]*\\}\\s*=(?![=>])`).test(text);
    if (destructured || occurrences.some(({ index }) => occurrenceIsRead(text, index, name))) found.push(name);
  }
  return found;
}

test("no test file reads a native fixture setting from process.env itself", () => {
  const offenders = [];
  for (const file of sources(testRoot)) {
    // The helper reads the settings; this file only names them in checker cases.
    if (file === helperFile || file === import.meta.filename) continue;
    const found = directReads(fs.readFileSync(file, "utf8"));
    if (found.length) offenders.push(`${path.relative(testRoot, file)}: ${found.join(", ")}`);
  }
  assert.deepEqual(offenders, [], "Read these settings through test/helpers/native-fixtures.mjs");
  // The checker itself recognises each spelling of a read.
  assert.deepEqual(directReads("x = process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT;"), ["HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT"]);
  assert.deepEqual(directReads('x = process.env["LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT"];'), ["LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT"]);
  assert.deepEqual(directReads("const { LODE_AGENT_GO_WORKER_FIXTURE_ROOT: root } = process.env;"), ["LODE_AGENT_GO_WORKER_FIXTURE_ROOT"]);
  assert.deepEqual(directReads("x = globalThis.process.env['HEAD_AGENT_GO_WORKER_FIXTURE_ROOT'];"), ["HEAD_AGENT_GO_WORKER_FIXTURE_ROOT"]);
  assert.deepEqual(directReads("const root = process.env?.LODE_AGENT_GO_WORKER_FIXTURE_ROOT;"), ["LODE_AGENT_GO_WORKER_FIXTURE_ROOT"]);
  assert.deepEqual(directReads("const e = process.env; const root = e.HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT;"), ["HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT"]);
  assert.deepEqual(directReads("const { env } = process; const root = env.LODE_AGENT_TEST_OWNER_CRASH_FIXTURE;"), ["LODE_AGENT_TEST_OWNER_CRASH_FIXTURE"]);
  assert.deepEqual(directReads('const name = "LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT"; const root = process.env[name];'), [
    "LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT",
  ]);
  assert.deepEqual(directReads("const { HEAD_AGENT_TEST_CODEX_BIN } = env;"), ["HEAD_AGENT_TEST_CODEX_BIN"]);
  // Not reads: removal, assignment, object keys, longer text, regex literals.
  assert.deepEqual(directReads("delete env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT;"), []);
  assert.deepEqual(directReads('delete env["HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT"];'), []);
  assert.deepEqual(directReads("env.LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT = root;"), []);
  assert.deepEqual(directReads("run({ ...process.env, LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT: root });"), []);
  assert.deepEqual(directReads('x = { "LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT": root };'), []);
  assert.deepEqual(directReads('t.skip("needs LODE_AGENT_TEST_CODEX_BIN set");'), []);
  assert.deepEqual(directReads("assert.match(runner, /LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT/);"), []);
  // The runner pin (group G's) only sets and removes the supervisor variable.
  assert.deepEqual(directReads(fs.readFileSync(path.join(testRoot, "npm-test-entrypoint.test.mjs"), "utf8")), []);
});

test("settings are read under the canonical name first and the historical name second", () => {
  const canonical = NATIVE_FIXTURE_SETTINGS.supervisorRoot;
  const legacy = ENVIRONMENT_NAME_PAIRS.find((item) => item.canonical === canonical).legacy;
  assert.equal(testSetting(canonical, {}), null);
  assert.equal(testSetting(canonical, { [legacy]: "old" }), "old");
  assert.equal(testSetting(canonical, { [canonical]: "new", [legacy]: "old" }), "new");
  assert.equal(testSetting(canonical, { [canonical]: "", [legacy]: "old" }), "old", "An empty value counts as unset");
  assert.equal(supervisorFixtureRoot({ [legacy]: "old" }), "old");
  assert.equal(settingNames(canonical), `${canonical} (or ${legacy})`);
  assert.throws(() => testSetting("LODE_AGENT_NOT_A_SETTING", {}), /No compatibility pair/);
});

test("the file-effect root falls back to a verified supervisor root and an explicit root wins", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-native-fixture-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "dist", process.platform === "win32" ? "windows-x64" : `${process.platform}-${process.arch}`);
  fs.mkdirSync(directory, { recursive: true });
  const binaryFile = path.join(directory, process.platform === "win32" ? "lode-agent-supervisor.exe" : "lode-agent-supervisor");
  fs.writeFileSync(binaryFile, "not executed: settings fixture", { flag: "wx", mode: 0o755 });
  const manifest = createProcessSupervisorManifest({ platform: process.platform, arch: process.arch, binaryFile, manifestDirectory: directory });
  fs.writeFileSync(path.join(directory, "SUPERVISOR-MANIFEST.json"), JSON.stringify(manifest), { flag: "wx" });

  const supervisor = NATIVE_FIXTURE_SETTINGS.supervisorRoot,
    fileEffect = NATIVE_FIXTURE_SETTINGS.fileEffectRoot;
  assert.equal(fileEffectFixtureRoot({}), null);
  assert.equal(fileEffectFixtureRoot({ [supervisor]: root }), root);
  assert.equal(fileEffectFixtureRoot({ [supervisor]: root, [fileEffect]: "explicit" }), "explicit");
  // A supervisor root that does not verify is broken wiring: it fails, it does not skip.
  fs.appendFileSync(binaryFile, "tamper");
  assert.throws(() => fileEffectFixtureRoot({ [supervisor]: root }), { code: "PROCESS_SUPERVISOR_BINARY_DIGEST_MISMATCH" });
});

test("skip reasons start with their class and name both spellings of a setting", () => {
  const classes = ["other-os: ", "native-fixture: ", "ci-step: ", "opt-in: ", "no-source: ", "filesystem: ", "host-limit: "];
  const reasons = [
    skipReason.otherOperatingSystem("Windows", "x"),
    skipReason.nativeFixture(NATIVE_FIXTURE_SETTINGS.goWorkerRoot, "x"),
    skipReason.ciStep("step", NATIVE_FIXTURE_SETTINGS.goWorkerRoot, "x"),
    skipReason.optInExternalProgram(NATIVE_FIXTURE_SETTINGS.codexHostDiscovery, "x"),
    skipReason.fixtureHasNoSource("x"),
    skipReason.filesystemProperty("x"),
    skipReason.hostLimit("x"),
  ];
  reasons.forEach((reason, index) => assert.ok(reason.startsWith(classes[index]), reason));
  assert.match(reasons[1], /LODE_AGENT_GO_WORKER_FIXTURE_ROOT \(or HEAD_AGENT_GO_WORKER_FIXTURE_ROOT\)/);
  assert.equal(nativeFixtureSkip("x", { environment: { [NATIVE_FIXTURE_SETTINGS.supervisorRoot]: "root" } }), false);
  assert.ok(nativeFixtureSkip("x", { environment: {} }).startsWith("native-fixture: "));
  const both = [NATIVE_FIXTURE_SETTINGS.ownerCrashFixture, NATIVE_FIXTURE_SETTINGS.terminalHoldRoot];
  assert.equal(
    missingSettingsSkip("x", both, {}),
    "native-fixture: LODE_AGENT_TEST_OWNER_CRASH_FIXTURE (or HEAD_AGENT_TEST_OWNER_CRASH_FIXTURE) and LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT (or HEAD_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT) not set; x needs them",
  );
  assert.equal(
    missingSettingsSkip("x", both, { HEAD_AGENT_TEST_OWNER_CRASH_FIXTURE: "helper" }),
    "native-fixture: LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT (or HEAD_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT) not set; x needs it",
  );
  assert.equal(missingSettingsSkip("x", both, { LODE_AGENT_TEST_OWNER_CRASH_FIXTURE: "a", LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT: "b" }), false);
  const windows = windowsNativeSkip("x", { environment: {} });
  assert.ok(windows.startsWith(process.platform === "win32" ? "native-fixture: " : "other-os: "), windows);
});

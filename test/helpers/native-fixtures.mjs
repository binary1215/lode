// The one place tests read the locations of native fixtures and the other
// test-only settings of the native worker lanes. Each setting is read under its
// canonical LODE_AGENT_ name first and its historical HEAD_AGENT_ name second
// (compat/head/public-names.mjs lists the pairs). Test files never read these
// variables from process.env themselves; test/native-fixture-settings.test.mjs
// pins that.
import { ENVIRONMENT_NAME_PAIRS } from "../../compat/head/public-names.mjs";
import { resolveVerifiedProcessSupervisor } from "../../scripts/lib/runtime/runtime-process-supervisor.mjs";

export const NATIVE_FIXTURE_SETTINGS = Object.freeze({
  supervisorRoot: "LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT",
  fileEffectRoot: "LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT",
  goWorkerRoot: "LODE_AGENT_GO_WORKER_FIXTURE_ROOT",
  ownerCrashFixture: "LODE_AGENT_TEST_OWNER_CRASH_FIXTURE",
  terminalHoldRoot: "LODE_AGENT_TEST_TERMINAL_HOLD_FIXTURE_ROOT",
  codexHostDiscovery: "LODE_AGENT_TEST_CODEX_HOST_DISCOVERY",
  codexBinary: "LODE_AGENT_TEST_CODEX_BIN",
});

function pair(canonical) {
  const found = ENVIRONMENT_NAME_PAIRS.find((item) => item.canonical === canonical);
  if (!found) throw new Error(`No compatibility pair for ${canonical}`);
  return found;
}

// Both spellings, canonical first, for reason texts and messages. A variable
// with no historical spelling is named alone.
export function settingNames(canonical) {
  const found = ENVIRONMENT_NAME_PAIRS.find((item) => item.canonical === canonical);
  return found ? `${canonical} (or ${found.legacy})` : canonical;
}

// An empty value counts as unset under either name.
export function testSetting(canonical, environment = process.env) {
  const { legacy } = pair(canonical);
  for (const name of [canonical, legacy]) {
    const value = environment[name];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

export const supervisorFixtureRoot = (environment) => testSetting(NATIVE_FIXTURE_SETTINGS.supervisorRoot, environment);
export const goWorkerFixtureRoot = (environment) => testSetting(NATIVE_FIXTURE_SETTINGS.goWorkerRoot, environment);
export const ownerCrashFixture = (environment) => testSetting(NATIVE_FIXTURE_SETTINGS.ownerCrashFixture, environment);
export const terminalHoldFixtureRoot = (environment) => testSetting(NATIVE_FIXTURE_SETTINGS.terminalHoldRoot, environment);
export const codexHostDiscoverySelected = (environment) => testSetting(NATIVE_FIXTURE_SETTINGS.codexHostDiscovery, environment) === "1";
export const codexTestBinary = (environment) => testSetting(NATIVE_FIXTURE_SETTINGS.codexBinary, environment);

// The file-effect bridge is the supervisor binary itself (`--file-effect`).
// Without an explicit file-effect root, the supervisor root serves when its
// verified manifest declares the file-effect operations. A supervisor root that
// does not verify throws here: broken wiring must fail, not skip.
export function fileEffectFixtureRoot(environment) {
  const explicit = testSetting(NATIVE_FIXTURE_SETTINGS.fileEffectRoot, environment);
  if (explicit) return explicit;
  const supervisor = supervisorFixtureRoot(environment);
  if (!supervisor) return null;
  const operations = resolveVerifiedProcessSupervisor({ pluginRoot: supervisor }).manifest.capabilities.fileEffects?.operations;
  return Array.isArray(operations) && operations.includes("edit") && operations.includes("image-apply") ? supervisor : null;
}

// Skip reasons. Every reason is `<class>: <plain explanation>`; the classes are
// the ones declared in test/fixtures/skip-ledger.json, which the runner checks.
export const skipReason = Object.freeze({
  otherOperatingSystem: (required, what) => `other-os: ${what} runs only on ${required}`,
  nativeFixture: (canonical, what) => `native-fixture: ${settingNames(canonical)} not set; ${what} needs it`,
  ciStep: (step, canonical, what) => `ci-step: ${what} runs in the CI step "${step}" with ${settingNames(canonical)}`,
  optInExternalProgram: (canonical, what) => `opt-in: ${what}; select it with ${settingNames(canonical)}`,
  fixtureHasNoSource: (what) => `no-source: ${what}`,
  filesystemProperty: (what) => `filesystem: ${what}`,
  hostLimit: (what) => `host-limit: ${what}`,
});

// The gate of a native lane on any operating system. Returns false when the
// test can run, otherwise the reason text.
export function nativeFixtureSkip(what, { supervisor = true, fileEffect = false, environment } = {}) {
  if (supervisor && !supervisorFixtureRoot(environment)) return skipReason.nativeFixture(NATIVE_FIXTURE_SETTINGS.supervisorRoot, what);
  if (fileEffect && !fileEffectFixtureRoot(environment)) return skipReason.nativeFixture(NATIVE_FIXTURE_SETTINGS.fileEffectRoot, what);
  return false;
}

// The gate of a test that needs several test-only settings: names every one
// that is missing (the runner matches the canonical names it could not supply).
export function missingSettingsSkip(what, canonicalNames, environment) {
  const missing = canonicalNames.filter((canonical) => !testSetting(canonical, environment));
  if (!missing.length) return false;
  return `native-fixture: ${missing.map(settingNames).join(" and ")} not set; ${what} needs ${missing.length > 1 ? "them" : "it"}`;
}

// The usual gate of the Windows native lanes: other OS first, then a missing
// fixture.
export function windowsNativeSkip(what, options = {}) {
  if (process.platform !== "win32") return skipReason.otherOperatingSystem("Windows", what);
  return nativeFixtureSkip(what, options);
}

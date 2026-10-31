import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { initializeProject } from "../scripts/lib/lode-core.mjs";
import { createNativeObservationStore } from "../scripts/lib/native-session-observations.mjs";
import { appendUserPromptReference, captureUserPrompt, freezeUserPromptReference, takeUserPromptReference, prepareUserPromptReference, acknowledgeUserPromptReference, USER_PROMPT_REFERENCE_LIMITS } from "../scripts/lib/user-prompt-reference.mjs";
import { runSessionHostHook, writeSessionHostOutput } from "../scripts/session-host-hook.mjs";
import plugin from "../scripts/opencode-plugin.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const tree = root => fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter(name => !String(name).split(/[\\/]/u).includes("messaging")).sort() : [];
function readTree(root) {
  if (!fs.existsSync(root)) return "";
  const files = [];
  const walk = directory => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else files.push(fs.readFileSync(file, "utf8"));
    }
  };
  walk(root);
  return files.join("\n");
}

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-prompt-reference-")));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["claude", "codex", "opencode"] });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "operational") };
  return { base, root, environment };
}

const start = (root, runtime, source, sessionId) => ({
  hook_event_name: "SessionStart", source, cwd: root, session_id: sessionId,
});

test("prompt reference is redacted, bounded, and omitted when it does not fit", t => {
  const { root, environment } = fixture(t);
  const secret = [
    "-----BEGIN PRIVATE KEY-----\nsecret-key-body\n-----END PRIVATE KEY-----",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "ghp_abcdefghijklmnopqrstuvwxyz",
    "github_pat_abcdefghijklmnopqrstuvwxyz",
    "AKIAABCDEFGHIJKLMNOP",
    "Bearer abcdefghijklmnop",
    "xoxb-abcdefghijklmnopqrstuvwxyz",
  ].join(" ");
  captureUserPrompt({ root, runtime: "claude", nativeSessionId: "redacted-session", text: secret, environment });
  freezeUserPromptReference({ root, runtime: "claude", nativeSessionId: "redacted-session", environment });
  const redacted = takeUserPromptReference({ root, runtime: "claude", nativeSessionId: "redacted-session", environment });
  assert.equal(redacted.includes("secret-key-body"), false);
  assert.equal(redacted.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(redacted.includes("ghp_abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(redacted.includes("github_pat_abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(redacted.includes("AKIAABCDEFGHIJKLMNOP"), false);
  assert.equal(redacted.includes("abcdefghijklmnop"), false);
  assert.equal(redacted.includes("[redacted-private-key]"), true);
  assert.equal(redacted.includes("[redacted-token]"), true);
  assert.equal(appendUserPromptReference("base", "1. later", 8), "base");
  assert.equal(USER_PROMPT_REFERENCE_LIMITS.prompts, 3);
  assert.equal(USER_PROMPT_REFERENCE_LIMITS.characters, 2000);
  assert.equal(USER_PROMPT_REFERENCE_LIMITS.bytes, 16 * 1024);
});

test("Claude and Codex restore the frozen prompt after compact or clear and not on startup", async t => {
  const { root, environment } = fixture(t);
  const canon = () => tree(path.join(root, ".lode"));
  for (const runtime of ["claude", "codex"]) {
    const sessionId = runtime + "-session";
    const before = canon();
    const prompt = "restore " + runtime + " prompt sk-abcdefghijklmnopqrstuvwxyz";
    assert.deepEqual(await runSessionHostHook({
      runtime, environment, observeOnly: true,
      event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: sessionId, prompt_id: "p1", turn_id: "p1", prompt },
    }), {});
    assert.deepEqual(await runSessionHostHook({
      runtime, environment, observeOnly: true,
      event: { hook_event_name: "Stop", cwd: root, session_id: sessionId, prompt_id: "p1", turn_id: "p1", last_assistant_message: "A visible bounded proposal" },
    }), {});
    const snapshot = createNativeObservationStore({ environment }).read({
      root, caller: { runtime, nativeSessionId: sessionId, agentId: null },
    });
    assert.equal(JSON.stringify(snapshot).includes(prompt), false);
    assert.equal(JSON.stringify(snapshot).includes("SECRET"), false);
    assert.deepEqual(await runSessionHostHook({
      runtime, environment, observeOnly: true,
      event: { hook_event_name: "PreCompact", cwd: root, session_id: sessionId, trigger: "auto", turn_id: "p1" },
    }), {});
    await runSessionHostHook({
      runtime, environment, observeOnly: true,
      event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: sessionId, prompt_id: "p2", turn_id: "p2", prompt: "replacement after freeze" },
    });
    const startup = await runSessionHostHook({ runtime, environment, event: start(root, runtime, "startup", sessionId) });
    assert.equal(startup.hookSpecificOutput.additionalContext.includes("restore " + runtime), false);
    const compact = await runSessionHostHook({ runtime, environment, event: start(root, runtime, "compact", sessionId) });
    const text = compact.hookSpecificOutput.additionalContext;
    assert.equal(text.includes("non-authoritative"), true);
    assert.equal(text.includes("restore " + runtime + " prompt"), true);
    assert.equal(text.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
    assert.equal(text.includes("[redacted-token]"), true);
    assert.equal(text.includes("replacement after freeze"), false);
    assert.equal(text.includes("A visible bounded proposal"), true);
    assert.match(text, /unverified/);
    assert.match(text, /not-inferred/);
    assert.ok(text.length <= (runtime === "claude" ? 10000 : 32768));
    const again = await runSessionHostHook({ runtime, environment, event: start(root, runtime, "compact", sessionId) });
    assert.equal(again.hookSpecificOutput.additionalContext.includes("restore " + runtime), false);
    await runSessionHostHook({
      runtime, environment, observeOnly: true,
      event: { hook_event_name: "UserPromptSubmit", cwd: root, session_id: sessionId, prompt_id: "p3", turn_id: "p3", prompt: "after clear " + runtime },
    });
    const cleared = await runSessionHostHook({ runtime, environment, event: start(root, runtime, "clear", sessionId) });
    assert.equal(cleared.hookSpecificOutput.additionalContext.includes("after clear " + runtime), true);
    assert.deepEqual(canon(), before);
    const mailbox = readTree(path.join(root, ".lode", "messaging"));
    assert.equal(mailbox.includes(prompt), false);
    assert.equal(mailbox.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  }
  const claude = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks/claude.json"), "utf8"));
  const codex = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks/codex.json"), "utf8"));
  assert.equal(claude.hooks.PreCompact[0].matcher, "manual|auto");
  assert.equal(codex.hooks.PreCompact[0].matcher, "manual|auto");
  assert.ok(claude.hooks.PreCompact[0].hooks[0].command.endsWith("--runtime claude --observe-only"));
  assert.ok(codex.hooks.PreCompact[0].hooks[0].command.endsWith("--runtime codex --observe-only"));
});

test("capture keeps three bounded prompts and drops a frozen replacement", t => {
  const { root, environment } = fixture(t);
  for (const text of ["one", "two", "three", "x".repeat(2500)]) {
    captureUserPrompt({ root, runtime: "opencode", nativeSessionId: "ses_bounds", text, environment });
  }
  const file = fs.readdirSync(path.join(environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT, "user-prompt-reference"))[0];
  const state = JSON.parse(fs.readFileSync(path.join(environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT, "user-prompt-reference", file), "utf8"));
  assert.deepEqual(state.prompts.map(prompt => prompt.text.slice(0, 3)), ["two", "thr", "xxx"]);
  assert.equal(state.prompts.at(-1).text.length, 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= USER_PROMPT_REFERENCE_LIMITS.bytes);
});

test("OpenCode reinjects once after compaction or clear and ignores synthetic parts", async t => {
  const { root, environment } = fixture(t);
  const sessionID = "ses_prompt";
  const canon = tree(path.join(root, ".lode"));
  const client = { session: {
    async get() { return { data: { id: sessionID, projectID: "host-project", directory: root } }; },
    async status() { return { data: {} }; },
  } };
  const hooks = await plugin.server({ client, project: { id: "host-project" }, directory: root }, { environment });
  t.after(() => hooks.dispose());
  await hooks.event({ event: { id: "user-message", type: "message.updated", properties: { info: { id: "msg_user", sessionID, role: "user" } } } });
  await hooks.event({ event: { id: "assistant-message", type: "message.updated", properties: { info: { id: "msg_assistant", sessionID, role: "assistant" } } } });
  await hooks.event({ event: { id: "user-part", type: "message.part.updated", properties: { part: {
    id: "part-user", sessionID, messageID: "msg_user", type: "text", text: "keep the opencode prompt",
  } } } });
  await hooks.event({ event: { id: "synthetic-part", type: "message.part.updated", properties: { part: {
    id: "part-synthetic", sessionID, messageID: "msg_user", type: "text", text: "synthetic secret", synthetic: true,
  } } } });
  await hooks.event({ event: { id: "assistant-part", type: "message.part.updated", properties: { part: {
    id: "part-assistant", sessionID, messageID: "msg_assistant", type: "text", text: "assistant secret",
  } } } });
  const ordinary = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, ordinary);
  assert.equal(ordinary.system.some(text => text.includes("keep the opencode prompt")), false);
  const compaction = { context: ["host context"], prompt: undefined };
  await hooks["experimental.session.compacting"]({ sessionID }, compaction);
  assert.deepEqual(compaction, { context: ["host context"], prompt: undefined });
  await hooks.event({ event: { id: "later-part", type: "message.part.updated", properties: { part: {
    id: "part-later", sessionID, messageID: "msg_user", type: "text", text: "replacement after freeze",
  } } } });
  await hooks.event({ event: { id: "compacted", type: "session.compacted", properties: { sessionID } } });
  const restored = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, restored);
  const combined = restored.system.join("\n");
  assert.equal(combined.includes("keep the opencode prompt"), true);
  assert.equal(combined.includes("non-authoritative"), true);
  assert.equal(combined.includes("synthetic secret"), false);
  assert.equal(combined.includes("assistant secret"), false);
  assert.equal(combined.includes("replacement after freeze"), false);
  await hooks["experimental.chat.system.transform"]({ sessionID }, restored);
  assert.match(restored.system.join("\n"), /keep the opencode prompt/, "Rebuilding the same output object retains its already included local reference");
  const repeated = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, repeated);
  assert.equal(repeated.system.some(text => text.includes("keep the opencode prompt")), false);
  await hooks.event({ event: { id: "clear-message", type: "message.updated", properties: { info: { id: "msg_clear", sessionID, role: "user" } } } });
  await hooks.event({ event: { id: "clear-part", type: "message.part.updated", properties: { part: {
    id: "part-clear", sessionID, messageID: "msg_clear", type: "text", text: "after opencode clear",
  } } } });
  await hooks["command.executed"]({ name: "clear", sessionID, arguments: "" });
  const cleared = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, cleared);
  assert.equal(cleared.system.join("\n").includes("after opencode clear"), true);
  assert.deepEqual(tree(path.join(root, ".lode")), canon);
});

test("an OpenCode output rejected after preparation keeps the frozen reference for retry", async t => {
  const { root, environment } = fixture(t), sessionID = "ses_rejected_output";
  const caller = { root, runtime: "opencode", nativeSessionId: sessionID, environment };
  captureUserPrompt({ ...caller, text: "keep this undelivered reference" });
  freezeUserPromptReference(caller);
  const hooks = await plugin.server({ directory: root, project: { id: "host-project" }, client: { session: {
    async get() { return { data: { id: sessionID, projectID: "host-project", directory: root } }; },
  } } }, { environment });
  t.after(() => hooks.dispose());
  const rejected = new Proxy([], { set() { throw new Error("Synthetic output append failure"); } });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: rejected });
  const retry = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, retry);
  assert.match(retry.system.join("\n"), /keep this undelivered reference/);
});

test("reference preparation respects exact output bounds and cannot consume a changed caller generation", t => {
  const { root, environment } = fixture(t), caller = { root, runtime: "codex", nativeSessionId: "prepared", environment };
  captureUserPrompt({ ...caller, text: "문맥 A", messageId: "a" });
  const prepared = prepareUserPromptReference({ ...caller, force: true });
  assert(prepared);
  for (const extra of [-1, 0, 1]) {
    const next = prepareUserPromptReference({ ...caller, force: true, additionalContext: "base", limit: 6 + prepared.text.length + extra });
    assert.equal(Boolean(next), extra >= 0);
  }
  assert.equal(captureUserPrompt({ ...caller, text: "문맥 A", messageId: "new-message-same-text" }).captured, true);
  assert.equal(acknowledgeUserPromptReference(prepared), false, "A stale preparation cannot erase a newer generation");
  const next = prepareUserPromptReference({ ...caller, force: true });
  assert.equal(next.text.split("문맥 A").length - 1, 2);
  assert.equal(acknowledgeUserPromptReference({ text: next.text }), false, "Only local preparations can be consumed");
  assert.equal(acknowledgeUserPromptReference(next), true);
  assert.equal(acknowledgeUserPromptReference(next), false);
  assert.equal(prepareUserPromptReference({ ...caller, force: true }), null);
});

test("command Hook delivery consumes only after a successful local stream callback, including backpressure", async t => {
  const { root, environment } = fixture(t), sessionId = "stream-caller";
  const caller = { root, runtime: "codex", nativeSessionId: sessionId, environment };
  captureUserPrompt({ ...caller, text: "retry this stream reference" });
  freezeUserPromptReference(caller);
  for (const outcome of ["throw", "callback-error", "error-event", "backpressure"]) {
    const sink = new EventEmitter(); let text = "";
    sink.write = (value, callback) => {
      text = value;
      if (outcome === "throw") throw new Error("Synthetic write failure");
      setImmediate(() => {
        assert(prepareUserPromptReference(caller), "Preparation must survive until local delivery completes");
        if (outcome === "callback-error") callback(new Error("Synthetic callback failure"));
        else if (outcome === "error-event") sink.emit("error", new Error("Synthetic EPIPE"));
        else callback();
      });
      return false;
    };
    const operation = runSessionHostHook({ runtime: "codex", environment, event: start(root, "codex", "compact", sessionId),
      deliver: output => writeSessionHostOutput(output, sink) });
    if (outcome === "backpressure") await operation;
    else { await assert.rejects(operation, /Synthetic/); assert(prepareUserPromptReference(caller)); }
    assert.match(text, /retry this stream reference/);
  }
  assert.equal(prepareUserPromptReference(caller), null);
});

test("visible Stop context is bounded Host input with unverified adjacency and human origin, never approval", async t => {
  const { root, environment } = fixture(t);
  for (const runtime of ["codex", "claude"]) {
    const sessionId = runtime + "-visible";
    const observe = async (hook_event_name, fields) => (await runSessionHostHook({ runtime, environment, observeOnly: true,
      event: { hook_event_name, cwd: root, session_id: sessionId, ...fields } }));
    await observe("UserPromptSubmit", { turn_id: "proposal-turn", prompt: "Investigate the local implementation" });
    await observe("Stop", { turn_id: "proposal-turn", last_assistant_message: "Propose local patch; password=synthetic-private-value", reasoning: "hidden reasoning must stay absent" });
    await observe("UserPromptSubmit", { turn_id: "reply-turn", prompt: "취소. 설명만 해줘" });
    if (runtime === "codex") await observe("Stop", { turn_id: "proposal-turn", last_assistant_message: "late stale final must not replace the current turn" });
    await observe("StopFailure", { last_assistant_message: "API error must not become a proposal" });
    const output = await runSessionHostHook({ runtime, environment, event: start(root, runtime, "compact", sessionId) });
    const text = output.hookSpecificOutput.additionalContext;
    for (const expected of ["Propose local patch", "취소. 설명만 해줘", "unverified", "not-inferred", "humanOrigin"]) assert(text.includes(expected), runtime + ": " + expected);
    for (const hidden of ["synthetic-private-value", "hidden reasoning", "API error must", "late stale final"]) assert(!text.includes(hidden), runtime + ": " + hidden);
    await observe("UserPromptSubmit", { turn_id: "null-turn", prompt: "A separate prompt" });
    await observe("Stop", { turn_id: "null-turn", last_assistant_message: null });
    const empty = await runSessionHostHook({ runtime, environment, event: start(root, runtime, "compact", sessionId) });
    assert(!empty.hookSpecificOutput.additionalContext.includes("Propose local patch"));
  }
});


test('review regression: prompt references are Project scoped and survive explicit Project relocation', async t => {
  const {base,root,environment}=fixture(t),other=path.join(base,'other-project');fs.mkdirSync(other);
  initializeProject({root:other,pluginRoot,runtimes:['claude']});
  const caller={runtime:'claude',nativeSessionId:'shared-native-session',environment};
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(root,'.lode/project.json'))).projectId,JSON.parse(fs.readFileSync(path.join(other,'.lode/project.json'))).projectId);
  captureUserPrompt({...caller,root,text:'Project A reference'});freezeUserPromptReference({...caller,root});
  assert.equal(takeUserPromptReference({...caller,root:other,force:true}),'');
  assert.match(takeUserPromptReference({...caller,root}),/Project A reference/);
  captureUserPrompt({...caller,root,text:'same Project after move'});freezeUserPromptReference({...caller,root});
  const moved=path.join(base,'moved-project');fs.cpSync(root,moved,{recursive:true});
  assert.equal(takeUserPromptReference({...caller,root:moved,force:true}),'','Unverified copies have no Project authority.');
  const {initializeOrResumeProject}=await import('../scripts/lib/project-bootstrap.mjs');
  await initializeOrResumeProject({root:moved,pluginRoot,profile:'core'});
  assert.match(takeUserPromptReference({...caller,root:moved}),/same Project after move/);
  assert.equal(takeUserPromptReference({...caller,root,force:true}),'','Same Project reference is consumed once.');
});

const promptDirectory = environment => path.join(environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT, "user-prompt-reference");
const promptFile = environment => path.join(promptDirectory(environment), fs.readdirSync(promptDirectory(environment)).find(name => name.endsWith(".json")));

function windowsAclFixture(t, file, action) {
  const script = String.raw`$ErrorActionPreference='Stop';$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;$item=Get-Item -LiteralPath $r.path -Force;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');
if($r.action -eq 'broaden'){$acl=if($item.PSIsContainer){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()};$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$inherit=if($item.PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None};foreach($who in @($sid,$system,[Security.Principal.SecurityIdentifier]::new('S-1-1-0'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($who,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))};$item.SetAccessControl($acl)};
$acl=$item.GetAccessControl();$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));[ordered]@{ownerCurrent=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value;protected=$acl.AreAccessRulesProtected;rules=$rules.Count;untrusted=@($rules|Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin @($sid.Value,$system.Value)}).Count;sddl=$acl.Sddl}|ConvertTo-Json -Compress`;
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  t.diagnostic(JSON.stringify({ event: "planned-synthetic-acl", executable, cwd: path.dirname(file), parent: process.pid, file, action, ports: [], windowsHide: true }));
  const result = childProcess.spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
    cwd: path.dirname(file), windowsHide: true, shell: false, encoding: "utf8", input: JSON.stringify({ path: file, action }), timeout: 5000,
  });
  t.diagnostic(JSON.stringify({ event: "synthetic-acl-exited", pid: result.pid, parent: process.pid, status: result.status, ports: [] }));
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}

test("Windows ACL privacy: broad inheritance and existing prompt paths are narrowed before plaintext, including stage and final", { skip: process.platform !== "win32" }, t => {
  const { root, environment } = fixture(t), operational = environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT;
  fs.mkdirSync(operational); const parentBefore = windowsAclFixture(t, operational, "broaden"); assert.equal(parentBefore.untrusted, 1);
  const caller = { root, runtime: "codex", nativeSessionId: "windows-acl", environment };
  const spawn = childProcess.spawnSync; let privateCalls = 0;
  t.mock.method(childProcess, "spawnSync", function(executable, args, options) {
    const request = JSON.parse(options.input);
    if (Array.isArray(request) && request.every(item => item.kind)) privateCalls++;
    t.diagnostic(JSON.stringify({ event: "planned-private-acl", executable, cwd: options?.cwd, parent: process.pid, ports: [], windowsHide: options?.windowsHide }));
    const result = spawn.call(this, executable, args, options);
    t.diagnostic(JSON.stringify({ event: "private-acl-exited", pid: result.pid, status: result.status, output: result.stdout === "private" ? "private" : "synthetic-inspection-json", error: result.stderr, parent: process.pid, ports: [] }));
    return result;
  });
  const open = fs.openSync, write = fs.writeFileSync, stages = new Map(); let stageChecks = 0;
  t.mock.method(fs, "openSync", function(file, ...args) { const fd = open.call(this, file, ...args); if (String(file).endsWith(".tmp") && String(file).includes("user-prompt-reference")) stages.set(fd, file); return fd; });
  t.mock.method(fs, "writeFileSync", function(file, ...args) {
    if (stages.has(file)) {
      const acl = windowsAclFixture(t, stages.get(file), "inspect"); stageChecks++;
      t.diagnostic(JSON.stringify({ stageAclBeforePlaintext: { untrusted: acl.untrusted, protected: acl.protected, ownerCurrent: acl.ownerCurrent } }));
      assert.equal(acl.untrusted, 0); assert.equal(acl.protected, true); assert.equal(acl.ownerCurrent, true);
    }
    return write.call(this, file, ...args);
  });
  const started = performance.now(); assert.equal(captureUserPrompt({ ...caller, text: "Synthetic private prompt only" }).captured, true);
  assert.equal(privateCalls, 2, "New capture needs one directory request and one new-stage request");
  t.diagnostic(`Capture including independent stage ACL inspection: ${Math.round(performance.now() - started)}ms`);
  for (const file of [promptDirectory(environment), promptFile(environment)]) {
    const acl = windowsAclFixture(t, file, "inspect"); assert.equal(acl.untrusted, 0); assert.equal(acl.protected, true); assert.equal(acl.ownerCurrent, true); assert.equal(acl.rules, 2);
    windowsAclFixture(t, file, "broaden");
  }
  const freezeStarted = performance.now(), callsBeforeFreeze = privateCalls; assert.equal(freezeUserPromptReference(caller).frozen, true);
  assert.equal(privateCalls - callsBeforeFreeze, 2, "Existing directory/file are batched; only the stage needs another request");
  t.diagnostic(`Freeze including independent stage ACL inspection: ${Math.round(performance.now() - freezeStarted)}ms`);
  for (const file of [promptDirectory(environment), promptFile(environment)]) assert.equal(windowsAclFixture(t, file, "inspect").untrusted, 0);
  assert.equal(windowsAclFixture(t, operational, "inspect").sddl, parentBefore.sddl, "General operational parent ACL must not change");
  assert(stageChecks >= 2); assert.deepEqual(fs.readdirSync(promptDirectory(environment)).filter(name => name.endsWith(".tmp")), []);
  t.diagnostic(`Synthetic capture + freeze + independent ACL inspections: ${Math.round(performance.now() - started)}ms; not provider/Host latency.`);
});

test("Windows ACL privacy: failed verification never claims capture or leaves an owned empty stage", { skip: process.platform !== "win32" }, t => {
  const { root, environment } = fixture(t), caller = { root, runtime: "codex", nativeSessionId: "windows-failure", environment };
  const spawn = childProcess.spawnSync; let stageFailure = false, verifierUnavailable = false;
  t.mock.method(childProcess, "spawnSync", function(executable, args, options) {
    if (verifierUnavailable) return { status: 1, stdout: "", stderr: "Synthetic unavailable ACL verifier" };
    const request = options?.input && JSON.parse(options.input);
    if ((Array.isArray(request) ? request : [request]).some(item => item?.path?.endsWith(".tmp"))) { stageFailure = true; return { status: 1, stdout: "", stderr: "Synthetic ACL failure" }; }
    return spawn.call(this, executable, args, options);
  });
  assert.equal(captureUserPrompt({ ...caller, text: "Must never be written before verified private ACL" }).captured, false);
  assert(stageFailure); assert.deepEqual(fs.readdirSync(promptDirectory(environment)), []);
  verifierUnavailable = true;
  assert.equal(captureUserPrompt({ ...caller, text: "No fallback permission claim" }).captured, false);
  assert.equal(freezeUserPromptReference(caller).frozen, false); assert.equal(takeUserPromptReference({ ...caller, force: true }), "");
});

test("Windows ACL privacy: one public-operation deadline bounds remaining helpers and a failed batch cannot become capture success", { skip: process.platform !== "win32" }, t => {
  const { root, environment } = fixture(t), caller = { root, runtime: "codex", nativeSessionId: "deadline", environment };
  assert.equal(captureUserPrompt({ ...caller, text: "Synthetic batch failure baseline" }).captured, true);
  const file = promptFile(environment), spawn = childProcess.spawnSync; let now = 0, calls = 0, phase = "partial-batch";
  t.mock.method(childProcess, "spawnSync", function(executable, args, options) {
    calls++; assert(options.timeout > 0 && options.timeout <= 5000);
    if (phase === "partial-batch") {
      const requests = JSON.parse(options.input); assert.equal(requests.length, 2);
      fs.unlinkSync(file); // Exact generated synthetic P5 file only: disappear after preflight.
    }
    const result = spawn.call(this, executable, args, options); if (phase === "deadline") now = 6000; return result;
  });
  assert.equal(captureUserPrompt({ ...caller, text: "A partly checked ACL batch is not success" }).captured, false);
  assert.equal(calls, 1, "Batch failure cannot be retried into a successful prompt write");
  phase = "deadline"; calls = 0; t.mock.method(performance, "now", () => now);
  assert.equal(captureUserPrompt({ ...caller, text: "No success after an exhausted operation budget" }).captured, false);
  assert.equal(calls, 1, "No second helper may start after the shared deadline");
  assert.deepEqual(fs.readdirSync(promptDirectory(environment)), []);
});

test("privacy regression: credential masks cover case, temporary and truncated secrets without masking ordinary prose", t => {
  const { root, environment } = fixture(t);
  const cases = [
    ["lowercase bearer", "bearer abcdefghijklmnop", "abcdefghijklmnop"],
    ["mixed-case header", "AUTHORIZATION: bEaReR abcd", "abcd"],
    ["basic", "basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["basic sentence", "Basic dXNlcjpwYXNz.", "dXNlcjpwYXNz"],
    ["password JSON", '{"password":"synthetic-local-secret"}', "synthetic-local-secret"],
    ["password assignment", "PASSWORD = synthetic-secret", "synthetic-secret"],
    ["quoted whitespace", 'client_secret: "synthetic secret with spaces"', "synthetic secret"],
    ["temporary AWS", "ASIAABCDEFGHIJKLMNOP", "ASIAABCDEFGHIJKLMNOP"],
    ["GitHub OAuth", "gho_abcdefghijklmnopqrstuvwxyz", "gho_abcdefghijklmnopqrstuvwxyz"],
    ["truncated token", "sk-ant-oat01-abcd", "sk-ant-oat01-abcd"],
    ["partial PEM", "-----BEGIN PRIVATE KEY-----\nsynthetic-partial-body", "synthetic-partial-body"],
    ["long PEM", "-----BEGIN RSA PRIVATE KEY-----\n" + "synthetic-private-body".repeat(450) + "\n-----END RSA PRIVATE KEY-----", "synthetic-private-body"],
    ["truncated quoted password", 'password="synthetic-truncated-secret', "synthetic-truncated-secret"],
  ];
  for (const [name, text, secret] of cases) {
    const caller = { root, runtime: "claude", nativeSessionId: name, environment };
    assert.equal(captureUserPrompt({ ...caller, text }).captured, true, name);
    const stored = fs.readdirSync(promptDirectory(environment)).map(file => fs.readFileSync(path.join(promptDirectory(environment), file), "utf8")).join("");
    assert.equal(stored.includes(secret), false, name + " must be masked on disk");
    const output = takeUserPromptReference({ ...caller, force: true });
    assert.equal(output.includes(secret), false, name + " must be masked on reuse");
    assert.match(output, /\[redacted-(?:token|private-key)\]/, name);
  }
  const ordinary = "Discuss password rotation, Basic authentication, Basic Implementation guidance and Bearer Identity documentation. We discuss bearer authentication. Keep feature: password-reset, source IDs, Korean 문맥, AsiaPacific and exact product wording.";
  const caller = { root, runtime: "claude", nativeSessionId: "ordinary", environment };
  captureUserPrompt({ ...caller, text: ordinary });
  assert.ok(takeUserPromptReference({ ...caller, force: true }).includes(ordinary));
});

test("privacy regression: legacy prompt bodies are bounded and re-masked at freeze and forced reuse", t => {
  const { root, environment } = fixture(t);
  const caller = { root, runtime: "codex", nativeSessionId: "legacy", environment };
  for (const force of [false, true]) {
    captureUserPrompt({ ...caller, text: "placeholder" });
    const file = promptFile(environment);
    const legacy = { kind: "UserPromptReference", version: 1, reinject: false, prompts: [
      { messageId: "one", text: "password=synthetic-legacy-secret\n" + "ordinary ".repeat(300) },
      { messageId: "two", text: "-----BEGIN PRIVATE KEY-----\nsynthetic-legacy-key" },
    ] };
    fs.writeFileSync(file, JSON.stringify(legacy));
    if (!force) {
      assert.equal(freezeUserPromptReference(caller).frozen, true);
      assert.equal(fs.readFileSync(file, "utf8").includes("synthetic-legacy-secret"), false);
    }
    const output = takeUserPromptReference({ ...caller, force });
    assert.equal(output.includes("synthetic-legacy-secret"), false);
    assert.equal(output.includes("synthetic-legacy-key"), false);
    assert.ok(output.length <= 2 * USER_PROMPT_REFERENCE_LIMITS.characters + 512);
    assert.equal(fs.existsSync(file), false);
  }
});

test("privacy regression: prompt-only directory and atomic staging request private modes from creation", t => {
  const { root, environment } = fixture(t);
  const caller = { root, runtime: "codex", nativeSessionId: "modes", environment };
  const originalOpen = fs.openSync;
  const stages = [];
  t.mock.method(fs, "openSync", function(file, flags, mode) {
    const descriptor = originalOpen.call(this, file, flags, mode);
    if (String(file).endsWith(".tmp") && String(file).includes("user-prompt-reference")) {
      stages.push({ mode, actual: fs.fstatSync(descriptor).mode & 0o777 });
    }
    return descriptor;
  });
  assert.equal(captureUserPrompt({ ...caller, text: "private synthetic text" }).captured, true);
  assert.equal(stages.length, 1);
  assert.equal(stages[0].mode, 0o600, "the staging file must never start with default public permissions");
  if (process.platform !== "win32") {
    assert.equal(stages[0].actual, 0o600);
    assert.equal(fs.statSync(promptDirectory(environment)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(promptFile(environment)).mode & 0o777, 0o600);
    fs.chmodSync(promptDirectory(environment), 0o755);
    fs.chmodSync(promptFile(environment), 0o644);
    assert.equal(freezeUserPromptReference(caller).frozen, true);
    assert.equal(fs.statSync(promptDirectory(environment)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(promptFile(environment)).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(promptDirectory(environment)).filter(file => file.endsWith(".tmp")), []);
});

test("privacy regression: linked directories and non-regular or multiply-linked files are not read, changed or followed", t => {
  const { root, base, environment } = fixture(t);
  const caller = { root, runtime: "codex", nativeSessionId: "unsafe", environment };
  captureUserPrompt({ ...caller, text: "placeholder" });
  const file = promptFile(environment), directory = promptDirectory(environment);
  const outside = path.join(base, "outside.json");
  fs.renameSync(file, outside);
  fs.linkSync(outside, file);
  const original = fs.readFileSync(outside, "utf8"), mode = fs.statSync(outside).mode;
  assert.equal(captureUserPrompt({ ...caller, text: "must not replace a hardlink" }).captured, false);
  assert.equal(takeUserPromptReference({ ...caller, force: true }), "");
  assert.equal(fs.readFileSync(outside, "utf8"), original);
  assert.equal(fs.statSync(outside).mode, mode);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.equal(captureUserPrompt({ ...caller, text: "must not replace a directory" }).captured, false);
  fs.rmdirSync(file);
  fs.rmdirSync(directory);
  const target = path.join(base, "outside-directory"); fs.mkdirSync(target);
  fs.symlinkSync(target, directory, process.platform === "win32" ? "junction" : "dir");
  assert.equal(captureUserPrompt({ ...caller, text: "must not follow a directory link" }).captured, false);
  assert.equal(takeUserPromptReference({ ...caller, force: true }), "");
  assert.deepEqual(fs.readdirSync(target), []);
  fs.unlinkSync(directory);
});

test("privacy regression: oversized legacy files are not injected and caller/agent isolation remains exact", t => {
  const { root, environment } = fixture(t);
  const caller = { root, runtime: "codex", nativeSessionId: "parent", environment };
  captureUserPrompt({ ...caller, text: "parent-only reference" });
  assert.equal(takeUserPromptReference({ ...caller, nativeSessionId: "different", force: true }), "");
  assert.equal(takeUserPromptReference({ ...caller, agentId: "child", force: true }), "");
  const file = promptFile(environment);
  fs.writeFileSync(file, " ".repeat(USER_PROMPT_REFERENCE_LIMITS.bytes + 1));
  assert.equal(freezeUserPromptReference(caller).frozen, false);
  assert.equal(takeUserPromptReference({ ...caller, force: true }), "");
});

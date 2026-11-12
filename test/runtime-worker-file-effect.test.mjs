import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  invokeWorkerFileEffect,
  prepareWorkerFileEffectInvocation,
  invokePreparedWorkerFileEffect,
  verifyWorkerFileEffectBinding,
  verifyWorkerFileEffectTerminalProof,
  workerFileEffectNativeIntentId,
  WORKER_FILE_EFFECT_TRANSPORT_MAX_BYTES,
} from "../scripts/lib/runtime/runtime-worker-file-effect.mjs";
import { createProcessSupervisorManifest } from "../scripts/lib/runtime/runtime-process-supervisor.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "head-file-effect-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = process.platform === "win32" ? "windows-x64" : `${process.platform}-${process.arch}`;
  const directory = path.join(root, "dist", target);
  fs.mkdirSync(directory, { recursive: true });
  const binaryFile = path.join(directory, process.platform === "win32" ? "lode-agent-supervisor.exe" : "lode-agent-supervisor");
  fs.writeFileSync(binaryFile, "not executed: verified bridge mock fixture", { flag: "wx", mode: 0o755 });
  const manifest = createProcessSupervisorManifest({ platform: process.platform, arch: process.arch, binaryFile, manifestDirectory: directory });
  fs.writeFileSync(path.join(directory, "SUPERVISOR-MANIFEST.json"), JSON.stringify(manifest), { flag: "wx" });
  return { root, binaryFile, options: { pluginRoot: root } };
}
function reply(input, changes = {}) {
  const request = JSON.parse(input);
  return {
    protocolVersion: "0.1.0",
    requestId: request.requestId,
    operation: request.operation,
    payloadDigest: hash(Buffer.from(JSON.stringify(request.payload))),
    requestDigest: hash(input),
    status: "ok",
    authorityEffect: "none",
    result: { rootIdentity: "root-identity", ancestorIdentities: ["root-identity"] },
    ...changes,
  };
}
function mockSpawn(handler) {
  const calls = [];
  const spawnImplementation = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 99_999_999; // Synthetic marker; no OS process is launched.
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const chunks = [];
    let closed = false;
    child.close = (code = 0, signal = null) => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => child.emit("close", code, signal));
    };
    child.kill = (signal) => {
      calls.at(-1).signals.push(signal);
      child.close(null, signal);
      return true;
    };
    child.stdin = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final(callback) {
        callback();
        queueMicrotask(() => handler(child, Buffer.concat(chunks), options));
      },
    });
    calls.push({ command, args, options, signals: [] });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  return { spawnImplementation, calls };
}
const request = () => ({ operation: "probe", payload: { root: path.resolve("synthetic-root"), path: "example.txt" }, timeoutMs: 1000 });
const fileImage = (content, mode = 0o666) => ({ kind: "file", content: Buffer.from(content).toString("base64"), mode });
const absentImage = () => ({ kind: "absent" });
const imageDigest = (image) => hash(JSON.stringify(image.kind === "absent" ? { kind: "absent" } : { kind: "file", content: image.content, mode: image.mode }));
const imageRequest = (operation = "image-apply", changes = {}) => ({
  operation,
  payload: {
    effect: {
      root: path.resolve("synthetic-root"),
      rootIdentity: "root-identity",
      ancestorIdentities: ["root-identity"],
      path: "example.txt",
      before: absentImage(),
      after: fileImage(""),
      maxBytes: 64,
      ...changes,
    },
    journal: path.resolve("synthetic-journal"),
  },
});
const imageOutcome = (effect, changes = {}) => ({
  status: "effect-observed",
  intentId: `file-image-effect-${"a".repeat(64)}`,
  beforeImageDigest: imageDigest(effect.before),
  afterImageDigest: imageDigest(effect.after),
  currentImageDigest: imageDigest(effect.after),
  dataFlushed: effect.after.kind === "file" && (effect.before.kind === "absent" || effect.before.content !== effect.after.content),
  metadataCAS: false,
  multiFileAtomic: false,
  ...changes,
});
const notAttemptedOutcome = (effect) =>
  imageOutcome(effect, {
    status: "not-started",
    intentId: workerFileEffectNativeIntentId(effect),
    currentImageDigest: undefined,
    dataFlushed: false,
    intentPublication: "not-attempted",
  });
function respondNotAttempted(child, input, changes = {}) {
  const frame = JSON.parse(input);
  child.stdout.end(
    JSON.stringify(
      reply(input, { status: "error", result: { ...notAttemptedOutcome(frame.payload.effect), ...changes }, error: { code: "FILE_EFFECT_CONFLICT" } }),
    ),
  );
  child.close(2);
}

test("prepared capability binds source-phase proof before dispatch and keeps operational identity private", async (t) => {
  const { options } = fixture(t);
  const selected = { ...imageRequest(), requestId: `worker-effect-${"1".repeat(64)}` };
  const originalEffect = structuredClone(selected.payload.effect);
  const events = [];
  const mock = mockSpawn((child, input) => {
    assert.equal(JSON.parse(input).payload.effect.after.content, "");
    respondNotAttempted(child, input);
  });
  const handle = prepareWorkerFileEffectInvocation(selected, { ...options, ...mock, trustedHostFixture: true, onProcess: (event) => events.push(event) });
  assert.equal(mock.calls.length, 0);
  assert.equal(events.length, 0);
  assert(Object.isFrozen(handle) && Object.isFrozen(handle.binding.binaryIdentity.target));
  verifyWorkerFileEffectBinding(handle.binding, { operation: "image-apply", effect: originalEffect, requestId: selected.requestId });
  assert.equal("requestId" in handle.binding, false);
  selected.payload.effect.after = fileImage("mutated after preparation");
  const { response, terminalProof } = await invokePreparedWorkerFileEffect(handle);
  const verified = verifyWorkerFileEffectTerminalProof(terminalProof, {
    expectedBinding: handle.binding,
    expectedResponse: response,
    effect: originalEffect,
    requireLive: true,
  });
  assert.equal(verified.initialIntentNotAttempted, true);
  assert.equal(verified.provenance, "trusted-host-fixture");
  assert.equal(terminalProof.nativeResponse.result.intentPublication, "not-attempted");
  for (const privateValue of [selected.requestId, options.pluginRoot, originalEffect.root, selected.payload.journal])
    assert.equal(JSON.stringify(terminalProof).includes(privateValue), false);
  assert.equal("requestId" in terminalProof.nativeResponse, false);
  assert.equal("pid" in terminalProof, false);
  assert.equal(mock.calls.length, 1);
  assert.equal(events.at(-1).cleanupVerified, true);
  await assert.rejects(invokePreparedWorkerFileEffect(handle), { code: "WORKER_FILE_EFFECT_PREPARED_CAPABILITY_INVALID" });
  await assert.rejects(invokePreparedWorkerFileEffect(structuredClone(handle)), { code: "WORKER_FILE_EFFECT_PREPARED_CAPABILITY_INVALID" });
  const retained = structuredClone(terminalProof);
  assert.equal(verifyWorkerFileEffectTerminalProof(retained, { expectedBinding: handle.binding, effect: originalEffect }).initialIntentNotAttempted, true);
  assert.throws(() => verifyWorkerFileEffectTerminalProof(retained, { expectedBinding: handle.binding, effect: originalEffect, requireLive: true }), {
    code: "WORKER_FILE_EFFECT_PROOF_NOT_LIVE",
  });
});

test("terminal proof cannot move across an effect, request, binary or attempt binding", async (t) => {
  const { options } = fixture(t);
  const selected = { ...imageRequest(), requestId: "worker-attempt-one" };
  const mock = mockSpawn((child, input) => respondNotAttempted(child, input));
  const handle = prepareWorkerFileEffectInvocation(selected, { ...options, ...mock, trustedHostFixture: true });
  const { response, terminalProof } = await invokePreparedWorkerFileEffect(handle);
  const second = prepareWorkerFileEffectInvocation({ ...selected, requestId: "worker-attempt-two" }, { ...options, ...mock, trustedHostFixture: true });
  assert.throws(() =>
    verifyWorkerFileEffectTerminalProof(terminalProof, { expectedBinding: second.binding, effect: selected.payload.effect, requireLive: true }),
  );
  assert.throws(() => verifyWorkerFileEffectBinding(handle.binding, { requestId: "worker-attempt-two" }));
  assert.throws(() => verifyWorkerFileEffectBinding(handle.binding, { effect: { ...selected.payload.effect, after: fileImage("other") } }));
  const wrongBinary = structuredClone(handle.binding);
  wrongBinary.binaryIdentity.binarySha256 = "0".repeat(64);
  assert.throws(() => verifyWorkerFileEffectTerminalProof(terminalProof, { expectedBinding: wrongBinary, effect: selected.payload.effect }));
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  const pathBearing = structuredClone(handle.binding);
  pathBearing.binaryIdentity.target.directory = path.resolve("host-private");
  const { bindingDigest: ignored, ...pathBody } = pathBearing;
  pathBearing.bindingDigest = hash(JSON.stringify(canonical(pathBody)));
  assert.throws(() => verifyWorkerFileEffectBinding(pathBearing), { code: "INVALID_WORKER_FILE_EFFECT_RESPONSE" });
  const coerced = structuredClone(handle.binding);
  coerced.binaryIdentity.target.platform = [coerced.binaryIdentity.target.platform];
  const { bindingDigest: ignoredCoercion, ...coercedBody } = coerced;
  coerced.bindingDigest = hash(JSON.stringify(canonical(coercedBody)));
  assert.throws(() => verifyWorkerFileEffectBinding(coerced), { code: "INVALID_WORKER_FILE_EFFECT_RESPONSE" });
  for (const changes of [{ requestId: "worker-attempt-two" }, { requestDigest: "0".repeat(64) }, { operation: "image-retry" }]) {
    assert.throws(() =>
      verifyWorkerFileEffectTerminalProof(terminalProof, {
        expectedBinding: handle.binding,
        effect: selected.payload.effect,
        expectedResponse: { ...response, ...changes },
      }),
    );
  }
  const corrupted = structuredClone(terminalProof);
  corrupted.nativeResponse.result.intentId = `file-image-effect-${"0".repeat(64)}`;
  assert.throws(() => verifyWorkerFileEffectTerminalProof(corrupted, { expectedBinding: handle.binding, effect: selected.payload.effect }));
});

test("native publication claims require an initial exact source phase, not a caller assertion", async (t) => {
  const { options } = fixture(t);
  for (const changes of [
    { status: "incomplete-or-conflict" },
    { dataFlushed: true },
    { currentImageDigest: imageDigest(absentImage()) },
    { intentId: `file-image-effect-${"0".repeat(64)}` },
    { intentPublication: "not-published" },
    { intentPublication: "published" },
  ]) {
    const mock = mockSpawn((child, input) => respondNotAttempted(child, input, changes));
    await assert.rejects(invokePreparedWorkerFileEffect(prepareWorkerFileEffectInvocation(imageRequest(), { ...options, ...mock, trustedHostFixture: true })), {
      code: "INVALID_WORKER_FILE_EFFECT_RESPONSE",
      effectStatus: "unknown",
      retrySafe: false,
    });
  }
  for (const selected of [imageRequest("image-retry"), imageRequest("image-apply", { previousIntentId: `file-image-effect-${"a".repeat(64)}` })]) {
    const mock = mockSpawn((child, input) => respondNotAttempted(child, input));
    await assert.rejects(invokeWorkerFileEffect(selected, { ...options, ...mock }), { code: "INVALID_WORKER_FILE_EFFECT_RESPONSE", retrySafe: false });
  }
  const asserted = imageRequest("image-apply", { intentPublication: "not-attempted" });
  assert.throws(() => prepareWorkerFileEffectInvocation(asserted, options), { code: "INVALID_WORKER_FILE_EFFECT_REQUEST" });
  const untrustedMock = mockSpawn((child, input) => respondNotAttempted(child, input));
  const untrusted = await invokePreparedWorkerFileEffect(prepareWorkerFileEffectInvocation(imageRequest(), { ...options, ...untrustedMock }));
  assert.equal(untrusted.response.result.intentPublication, "not-attempted");
  assert.equal(untrusted.terminalProof, null);
});

test("prepared binary drift, timeout and unknown ownership never produce terminal retry evidence", async (t) => {
  const { options, binaryFile } = fixture(t);
  const mock = mockSpawn((child, input) => respondNotAttempted(child, input));
  const handle = prepareWorkerFileEffectInvocation(imageRequest(), { ...options, ...mock, trustedHostFixture: true });
  fs.appendFileSync(binaryFile, "drift");
  await assert.rejects(invokePreparedWorkerFileEffect(handle), { code: "PROCESS_SUPERVISOR_BINARY_DIGEST_MISMATCH" });
  assert.equal(mock.calls.length, 0);
  const stable = fixture(t);
  for (const scenario of ["timeout", "owner-unknown", "response-corrupt", "binary-after-start"]) {
    const events = [];
    const processMock = mockSpawn((child, input) => {
      if (scenario === "timeout") return;
      if (scenario === "response-corrupt") {
        child.stdout.end("{}");
        child.close(2);
        return;
      }
      if (scenario === "binary-after-start") fs.appendFileSync(stable.binaryFile, "after-start drift");
      respondNotAttempted(child, input);
    });
    const customSpawn = (...args) => {
      const child = processMock.spawnImplementation(...args);
      if (scenario === "owner-unknown") child.pid = undefined;
      return child;
    };
    const prepared = prepareWorkerFileEffectInvocation(
      { ...imageRequest(), timeoutMs: 15 },
      { ...stable.options, spawnImplementation: customSpawn, trustedHostFixture: true, onProcess: (event) => events.push(event) },
    );
    await assert.rejects(invokePreparedWorkerFileEffect(prepared));
    assert.equal(events.at(-1).cleanupVerified, true);
  }
});

test("image request rejects malformed and ambiguous images before launching a helper", async (t) => {
  const { options } = fixture(t);
  let started = 0;
  const childOptions = {
    ...options,
    spawnImplementation: () => {
      started++;
      throw new Error("must not spawn");
    },
  };
  const invalid = [
    { before: { kind: "absent", content: "" } },
    { before: { kind: "directory" } },
    { after: { kind: "file", content: "YQ", mode: 438 } },
    { after: { kind: "file", content: "YQ==\n", mode: 438 } },
    { after: { kind: "file", content: "", mode: "438" } },
    { after: fileImage("", 0o1000) },
    { after: fileImage("too big"), maxBytes: 1 },
    { maxBytes: -1 },
    { maxBytes: Number.MAX_SAFE_INTEGER + 1 },
    { after: absentImage() },
    { before: fileImage("same"), after: fileImage("same") },
    { rootIdentity: "", ancestorIdentities: [] },
    { ancestorIdentities: ["different-root"] },
    { previousIntentId: "unbound" },
    { phaseHook: "before-first-write" },
  ];
  for (const changes of invalid)
    await assert.rejects(invokeWorkerFileEffect(imageRequest("image-apply", changes), childOptions), {
      code: "INVALID_WORKER_FILE_EFFECT_REQUEST",
      effectStatus: "unknown",
      retrySafe: false,
    });
  assert.equal(started, 0);
});

test("image preflight binds discovery identities and reports capability loss without promoting authority", async (t) => {
  const { options } = fixture(t);
  const supported = {
    status: "supported",
    reason: "existing-parent-local-ntfs",
    operation: "create",
    rootIdentity: "root-identity",
    ancestorIdentities: ["root-identity"],
    modeSemantics: "windows-readonly-attribute-only",
    metadataCAS: false,
    multiFileAtomic: false,
  };
  const discovery = imageRequest("image-preflight", { rootIdentity: "", ancestorIdentities: [] });
  const mock = mockSpawn((child, input) => {
    child.stdout.end(JSON.stringify(reply(input, { result: supported })));
    child.close();
  });
  assert.deepEqual((await invokeWorkerFileEffect(discovery, { ...options, ...mock })).result, supported);
  const unsupported = {
    status: "unsupported",
    reason: "mode-not-representable",
    operation: "create",
    modeSemantics: "windows-readonly-attribute-only",
    metadataCAS: false,
    multiFileAtomic: false,
  };
  const modeMock = mockSpawn((child, input) => {
    child.stdout.end(JSON.stringify(reply(input, { result: unsupported })));
    child.close();
  });
  assert.equal(
    (await invokeWorkerFileEffect(imageRequest("image-preflight", { after: fileImage("", 0o644) }), { ...options, ...modeMock })).result.status,
    "unsupported",
  );
  const failed = mockSpawn((child, input) => {
    child.stdout.end(JSON.stringify(reply(input, { status: "error", result: undefined, error: { code: "FILE_EFFECT_CONFLICT" } })));
    child.close(2);
  });
  const conflict = await invokeWorkerFileEffect(discovery, { ...options, ...failed });
  assert.equal(conflict.status, "error");
  assert.equal(conflict.error.code, "FILE_EFFECT_CONFLICT");
  assert.equal("result" in conflict, false);
  for (const changes of [
    { rootIdentity: undefined },
    { ancestorIdentities: ["different"] },
    { reason: "mode-not-representable" },
    { operation: "delete" },
    { metadataCAS: true },
    { modeSemantics: "posix-acl" },
    { instruction: "continue anyway" },
  ]) {
    const malformed = mockSpawn((child, input) => {
      child.stdout.end(JSON.stringify(reply(input, { result: { ...supported, ...changes } })));
      child.close();
    });
    await assert.rejects(invokeWorkerFileEffect(discovery, { ...options, ...malformed }), { code: "INVALID_WORKER_FILE_EFFECT_RESPONSE" });
  }
});

test("image outcome binds kind, content and mode and never treats a zero-byte file as absent", async (t) => {
  const { options } = fixture(t);
  const operations = [
    { before: absentImage(), after: fileImage("") },
    { before: fileImage(""), after: absentImage() },
    { before: fileImage("before"), after: fileImage("after") },
    { before: fileImage("same"), after: fileImage("same", 0o444) },
  ];
  for (const changes of operations) {
    const selected = imageRequest("image-apply", changes);
    const result = imageOutcome(selected.payload.effect);
    assert.notEqual(result.beforeImageDigest, result.afterImageDigest);
    const mock = mockSpawn((child, input) => {
      child.stdout.end(JSON.stringify(reply(input, { result })));
      child.close();
    });
    assert.deepEqual((await invokeWorkerFileEffect(selected, { ...options, ...mock })).result, result);
    for (const corrupt of [
      { beforeImageDigest: hash("") },
      { afterImageDigest: imageDigest(fileImage("", 0o444)) },
      { currentImageDigest: result.beforeImageDigest },
      { dataFlushed: !result.dataFlushed },
      { metadataCAS: true },
      { intentId: "" },
    ]) {
      const bad = mockSpawn((child, input) => {
        child.stdout.end(JSON.stringify(reply(input, { result: { ...result, ...corrupt } })));
        child.close();
      });
      await assert.rejects(invokeWorkerFileEffect(selected, { ...options, ...bad }), {
        code: "INVALID_WORKER_FILE_EFFECT_RESPONSE",
        effectStatus: "unknown",
        retrySafe: false,
      });
    }
  }
});

test("image inspection preserves failure evidence and rejects invented retry or application", async (t) => {
  const { options } = fixture(t);
  const selected = imageRequest("image-inspect");
  const inspection = {
    intentId: `file-image-effect-${"b".repeat(64)}`,
    status: "preimage-observed",
    startedRecorded: false,
    noWriteRecorded: true,
    completionRecorded: false,
    currentImageDigest: imageDigest(absentImage()),
    retryBasisAvailable: true,
    appliedByThisRead: false,
  };
  const good = mockSpawn((child, input) => {
    child.stdout.end(JSON.stringify(reply(input, { result: inspection })));
    child.close();
  });
  assert.deepEqual((await invokeWorkerFileEffect(selected, { ...options, ...good })).result, inspection);
  for (const changes of [
    { currentImageDigest: hash("") },
    { currentImageDigest: undefined },
    { completionRecorded: true },
    { noWriteRecorded: false },
    { appliedByThisRead: true },
    { intentId: "" },
    { status: "postimage-observed" },
  ]) {
    const bad = mockSpawn((child, input) => {
      child.stdout.end(JSON.stringify(reply(input, { result: { ...inspection, ...changes } })));
      child.close();
    });
    await assert.rejects(invokeWorkerFileEffect(selected, { ...options, ...bad }), { code: "INVALID_WORKER_FILE_EFFECT_RESPONSE", retrySafe: false });
  }
  const outcome = imageOutcome(selected.payload.effect, { status: "incomplete-or-conflict", dataFlushed: false, currentImageDigest: undefined });
  const failed = mockSpawn((child, input) => {
    child.stdout.end(JSON.stringify(reply(input, { status: "error", result: outcome, error: { code: "FILE_EFFECT_IO_ERROR" } })));
    child.close(2);
  });
  const observed = await invokeWorkerFileEffect({ ...selected, operation: "image-retry" }, { ...options, ...failed });
  assert.equal(observed.status, "error");
  assert.equal(observed.result.status, "incomplete-or-conflict");
  assert.equal("retrySafe" in observed, false);
});

test("bridge verifies exact payload/frame and records a minimal-environment exact child", async (t) => {
  const { options, binaryFile } = fixture(t);
  const events = [];
  const mock = mockSpawn((child, input) => {
    assert.notEqual(input.at(-1), 10, "request has no trailing newline");
    const value = JSON.parse(input);
    assert.equal(value.payloadDigest, hash(Buffer.from(JSON.stringify(value.payload))));
    child.stdout.end(`${JSON.stringify(reply(input))}\n`);
    child.close();
  });
  const result = await invokeWorkerFileEffect(request(), { ...options, ...mock, onProcess: (event) => events.push(event) });
  assert.equal(result.status, "ok");
  assert.equal(result.authorityEffect, "none");
  assert.deepEqual(mock.calls[0].args, ["--file-effect"]);
  assert.equal(mock.calls[0].options.shell, false);
  assert.equal(mock.calls[0].options.windowsHide, true);
  assert.equal(mock.calls[0].options.cwd, path.dirname(binaryFile));
  assert(Object.keys(mock.calls[0].options.env).every((name) => ["systemroot", "windir", "temp", "tmp", "tmpdir", "lang"].includes(name.toLowerCase())));
  assert.deepEqual(
    events.map((event) => event.type),
    ["planned", "spawn", "exit"],
  );
  assert(events.every((event) => event.parentPid === process.pid && event.cwd === path.dirname(binaryFile) && event.ports.length === 0));
  assert.equal(events.at(-1).cleanupVerified, true);
});

test("unverified executable and out-of-bound requests never reach spawn", async (t) => {
  const { options, binaryFile } = fixture(t);
  let started = 0;
  const childOptions = {
    ...options,
    spawnImplementation: () => {
      started++;
      throw new Error("must not spawn");
    },
  };
  for (const invalid of [
    { maxRequestBytes: 10 },
    { maxResponseBytes: 4095 },
    { maxRequestBytes: WORKER_FILE_EFFECT_TRANSPORT_MAX_BYTES + 1 },
    { timeoutMs: 60_001 },
    { payload: { ...request().payload, phaseHook: "before-write" } },
    { operation: "shell" },
  ]) {
    await assert.rejects(invokeWorkerFileEffect({ ...request(), ...invalid }, childOptions));
  }
  let getterRead = false;
  await assert.rejects(
    invokeWorkerFileEffect(
      {
        ...request(),
        payload: {
          get root() {
            getterRead = true;
            return "unsafe";
          },
          path: "example.txt",
        },
      },
      childOptions,
    ),
  );
  assert.equal(getterRead, false);
  fs.appendFileSync(binaryFile, "tampered");
  await assert.rejects(invokeWorkerFileEffect(request(), childOptions), { code: "PROCESS_SUPERVISOR_BINARY_DIGEST_MISMATCH" });
  assert.equal(started, 0);
});

test("malformed, duplicate, trailing, divergent and authority-amplifying responses fail closed", async (t) => {
  const { options } = fixture(t);
  const cases = [
    (input) => `${JSON.stringify(reply(input))}{}`,
    (input) => JSON.stringify(reply(input)).replace('"status":"ok"', '"status":"error","st\\u0061tus":"ok"'),
    (input) => JSON.stringify(reply(input)).replace('"rootIdentity":"root-identity"', '"rootIdentity":"other","rootIdentity":"root-identity"'),
    (input) => JSON.stringify(reply(input, { requestId: "different" })),
    (input) => JSON.stringify(reply(input, { requestDigest: "0".repeat(64) })),
    (input) => JSON.stringify(reply(input, { payloadDigest: "0".repeat(64) })),
    (input) => JSON.stringify(reply(input, { authorityEffect: "review" })),
    (input) => JSON.stringify(reply(input, { before: "leaked source bytes" })),
    (input) => JSON.stringify(reply(input, { result: { rootIdentity: "root-identity", ancestorIdentities: ["different"] } })),
    () => Buffer.from([0xff]),
  ];
  for (const render of cases) {
    const mock = mockSpawn((child, input) => {
      child.stdout.end(render(input));
      child.close();
    });
    await assert.rejects(invokeWorkerFileEffect(request(), { ...options, ...mock }), {
      code: "INVALID_WORKER_FILE_EFFECT_RESPONSE",
      effectStatus: "unknown",
      retrySafe: false,
    });
  }
  const wrongExit = mockSpawn((child, input) => {
    child.stdout.end(JSON.stringify(reply(input)));
    child.close(2);
  });
  await assert.rejects(invokeWorkerFileEffect(request(), { ...options, ...wrongExit }), { code: "INVALID_WORKER_FILE_EFFECT_RESPONSE" });
});

test("native operational failure retains its exact outcome without inferring a safe retry", async (t) => {
  const { options } = fixture(t);
  const edit = {
    root: path.resolve("synthetic-root"),
    rootIdentity: "synthetic-root",
    ancestorIdentities: ["synthetic-root"],
    path: "example.txt",
    before: Buffer.from("before").toString("base64"),
    after: Buffer.from("after").toString("base64"),
    maxBytes: 64,
  };
  const outcome = {
    status: "incomplete-or-conflict",
    intentId: `file-effect-${"a".repeat(64)}`,
    beforeDigest: hash("before"),
    afterDigest: hash("after"),
    metadataCAS: false,
    multiFileAtomic: false,
  };
  const mock = mockSpawn((child, input) => {
    child.stdout.end(JSON.stringify(reply(input, { status: "error", result: outcome, error: { code: "FILE_EFFECT_IO_ERROR" } })));
    child.close(2);
  });
  const result = await invokeWorkerFileEffect({ operation: "edit", payload: { edit, journal: path.resolve("synthetic-journal") } }, { ...options, ...mock });
  assert.deepEqual(result.result, outcome);
  assert.equal(result.status, "error");
  assert.equal("retrySafe" in result, false);
});

test("inspection byte claims and retry evidence stay bound to the exact request", async (t) => {
  const { options } = fixture(t);
  const edit = {
    root: path.resolve("synthetic-root"),
    rootIdentity: "synthetic-root",
    ancestorIdentities: ["synthetic-root"],
    path: "example.txt",
    before: Buffer.from("before").toString("base64"),
    after: Buffer.from("after").toString("base64"),
    maxBytes: 64,
  };
  const result = {
    status: "preimage-observed",
    intentId: `file-effect-${"a".repeat(64)}`,
    currentDigest: hash("before"),
    startedRecorded: false,
    noWriteRecorded: true,
    completionRecorded: false,
    retryBasisAvailable: true,
    appliedByThisRead: false,
  };
  for (const changes of [
    { currentDigest: undefined },
    { currentDigest: hash("unrelated") },
    { intentId: "" },
    { completionRecorded: true },
    { status: "postimage-observed" },
  ]) {
    const mock = mockSpawn((child, input) => {
      child.stdout.end(JSON.stringify(reply(input, { result: { ...result, ...changes } })));
      child.close();
    });
    await assert.rejects(
      invokeWorkerFileEffect({ operation: "inspect", payload: { edit, journal: path.resolve("synthetic-journal") } }, { ...options, ...mock }),
      { code: "INVALID_WORKER_FILE_EFFECT_RESPONSE", effectStatus: "unknown" },
    );
  }
});

test("timeout, output overflow and stderr terminate only the owned child and remain uncertain", async (t) => {
  const { options } = fixture(t);
  for (const scenario of ["timeout", "overflow", "stderr"]) {
    const events = [];
    const mock = mockSpawn((child) => {
      if (scenario === "overflow") child.stdout.write(Buffer.alloc(4097));
      if (scenario === "stderr") child.stderr.write("unexpected diagnostic");
    });
    await assert.rejects(
      invokeWorkerFileEffect({ ...request(), maxResponseBytes: 4096, timeoutMs: 15 }, { ...options, ...mock, onProcess: (event) => events.push(event) }),
      {
        code: { timeout: "WORKER_FILE_EFFECT_TIMEOUT", overflow: "WORKER_FILE_EFFECT_RESPONSE_LIMIT", stderr: "WORKER_FILE_EFFECT_UNEXPECTED_STDERR" }[
          scenario
        ],
        effectStatus: "unknown",
        retrySafe: false,
      },
    );
    assert.deepEqual(mock.calls[0].signals, ["SIGTERM"]);
    assert.equal(events.at(-1).type, "exit");
    assert.equal(events.at(-1).cleanupVerified, true);
  }
});

test("observer failure after spawn terminates the owned child before returning", async (t) => {
  const { options } = fixture(t);
  const mock = mockSpawn(() => assert.fail("observer failed before sending the request"));
  await assert.rejects(
    invokeWorkerFileEffect(request(), {
      ...options,
      ...mock,
      onProcess(event) {
        if (event.type === "spawn") throw new Error("broken recorder");
      },
    }),
    { code: "WORKER_FILE_EFFECT_PROCESS_OBSERVER_FAILED", effectStatus: "unknown" },
  );
  assert.deepEqual(mock.calls[0].signals, ["SIGTERM"]);
});

test("failed graceful termination escalates only to the exact owned child", async (t) => {
  const { options } = fixture(t);
  const events = [];
  const mock = mockSpawn((child) => {
    const forceKill = child.kill;
    child.kill = (signal) => {
      if (signal === "SIGTERM") {
        mock.calls.at(-1).signals.push(signal);
        return false;
      }
      return forceKill(signal);
    };
  });
  await assert.rejects(invokeWorkerFileEffect({ ...request(), timeoutMs: 15 }, { ...options, ...mock, onProcess: (event) => events.push(event) }), {
    code: "WORKER_FILE_EFFECT_TIMEOUT",
    effectStatus: "unknown",
  });
  assert.deepEqual(mock.calls[0].signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(events.at(-1).cleanupVerified, true);
});

test("unconfirmed termination reports cleanup uncertainty and never claims release", async (t) => {
  const { options } = fixture(t);
  const events = [];
  const mock = mockSpawn((child) => {
    child.kill = (signal) => {
      mock.calls.at(-1).signals.push(signal);
      return false;
    };
  });
  await assert.rejects(invokeWorkerFileEffect({ ...request(), timeoutMs: 15 }, { ...options, ...mock, onProcess: (event) => events.push(event) }), {
    code: "WORKER_FILE_EFFECT_CLEANUP_UNVERIFIED",
    effectStatus: "unknown",
    retrySafe: false,
    pid: 99_999_999,
  });
  assert.deepEqual(mock.calls[0].signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(events.at(-1).type, "cleanup-unverified");
  assert.equal(
    events.some((event) => event.cleanupVerified),
    false,
  );
});

test("real verified native bridge edits and inspects a synthetic file without replay", async (t) => {
  const pluginRoot = process.env.LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT || process.env.HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT;
  if (!pluginRoot || process.platform !== "win32") {
    t.skip("requires an explicitly selected verified Windows file-effect fixture");
    return;
  }
  const { root } = fixture(t);
  const source = path.join(root, "source");
  const journal = path.join(root, "journal");
  fs.mkdirSync(source);
  fs.mkdirSync(journal);
  const file = path.join(source, "example.txt");
  fs.writeFileSync(file, "before", { flag: "wx" });
  const events = [];
  const options = {
    pluginRoot,
    onProcess: (event) => {
      events.push(event);
      t.diagnostic(JSON.stringify(event));
    },
  };
  const probed = await invokeWorkerFileEffect({ operation: "probe", payload: { root: source, path: "example.txt" } }, options);
  assert.equal(probed.status, "ok");
  const edit = {
    root: source,
    ...probed.result,
    path: "example.txt",
    before: Buffer.from("before").toString("base64"),
    after: Buffer.from("after").toString("base64"),
    maxBytes: 64,
  };
  const edited = await invokeWorkerFileEffect({ operation: "edit", payload: { edit, journal } }, options);
  assert.equal(edited.status, "ok");
  assert.equal(edited.result.status, "bytes-flushed");
  assert.equal(fs.readFileSync(file, "utf8"), "after");
  const inspected = await invokeWorkerFileEffect({ operation: "inspect", payload: { edit, journal } }, options);
  assert.equal(inspected.result.status, "postimage-observed");
  assert.equal(inspected.result.completionRecorded, true);
  assert.equal(inspected.result.appliedByThisRead, false);
  assert.equal(inspected.result.retryBasisAvailable, false);
  const replay = await invokeWorkerFileEffect({ operation: "edit", payload: { edit, journal } }, options);
  assert.equal(replay.status, "error");
  assert.equal(replay.error.code, "FILE_EFFECT_ALREADY_EXISTS");
  assert.equal(fs.readFileSync(file, "utf8"), "after");
  const retry = await invokeWorkerFileEffect({ operation: "retry", payload: { edit, journal } }, options);
  assert.equal(retry.status, "error");
  assert.equal(retry.error.code, "FILE_EFFECT_CONFLICT");
  assert.equal(events.filter((event) => event.type === "spawn").length, 5);
  assert.equal(events.filter((event) => event.type === "exit" && event.cleanupVerified).length, 5);
  for (const event of events.filter((event) => event.type === "spawn")) assert.throws(() => process.kill(event.pid, 0), { code: "ESRCH" });
});

test("real native no-write evidence permits only an exact linked retry after basis restoration", async (t) => {
  const pluginRoot = process.env.LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT || process.env.HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT;
  if (!pluginRoot || process.platform !== "win32") {
    t.skip("requires an explicitly selected verified Windows file-effect fixture");
    return;
  }
  const { root } = fixture(t);
  const source = path.join(root, "source");
  const journal = path.join(root, "journal");
  fs.mkdirSync(source);
  fs.mkdirSync(journal);
  const file = path.join(source, "example.txt");
  fs.writeFileSync(file, "changed", { flag: "wx" });
  const events = [];
  const options = {
    pluginRoot,
    onProcess: (event) => {
      events.push(event);
      t.diagnostic(JSON.stringify(event));
    },
  };
  const probed = await invokeWorkerFileEffect({ operation: "probe", payload: { root: source, path: "example.txt" } }, options);
  const edit = {
    root: source,
    ...probed.result,
    path: "example.txt",
    before: Buffer.from("before").toString("base64"),
    after: Buffer.from("after").toString("base64"),
    maxBytes: 64,
  };
  const rejected = await invokeWorkerFileEffect({ operation: "edit", payload: { edit, journal } }, options);
  assert.equal(rejected.status, "error");
  assert.equal(rejected.error.code, "FILE_EFFECT_CONFLICT");
  assert.equal(rejected.result.status, "not-started");
  assert.equal(fs.readFileSync(file, "utf8"), "changed");
  const notReady = await invokeWorkerFileEffect({ operation: "retry", payload: { edit, journal } }, options);
  assert.equal(notReady.status, "error");
  assert.equal(notReady.error.code, "FILE_EFFECT_CONFLICT");
  fs.writeFileSync(file, "before"); // Synthetic editor restores the original bytes, not an automatic bridge repair.
  const inspection = await invokeWorkerFileEffect({ operation: "inspect", payload: { edit, journal } }, options);
  assert.equal(inspection.result.noWriteRecorded, true);
  assert.equal(inspection.result.retryBasisAvailable, true);
  const retried = await invokeWorkerFileEffect({ operation: "retry", payload: { edit, journal } }, options);
  assert.equal(retried.status, "ok");
  assert.notEqual(retried.result.intentId, rejected.result.intentId);
  const retained = JSON.parse(fs.readFileSync(path.join(journal, `${retried.result.intentId}.intent.json`), "utf8"));
  assert.equal(retained.previousIntentId, rejected.result.intentId);
  assert.equal(fs.readFileSync(file, "utf8"), "after");
  const retryAgain = await invokeWorkerFileEffect({ operation: "retry", payload: { edit, journal } }, options);
  assert.equal(retryAgain.status, "error");
  assert.equal(fs.readFileSync(file, "utf8"), "after");
  assert.equal(events.filter((event) => event.type === "spawn").length, 6);
  assert.equal(events.filter((event) => event.type === "exit" && event.cleanupVerified).length, 6);
  for (const event of events.filter((event) => event.type === "spawn")) assert.throws(() => process.kill(event.pid, 0), { code: "ESRCH" });
});

test("real image bridge distinguishes create, edit, mode and delete with exact exit evidence", async (t) => {
  const pluginRoot = process.env.LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT || process.env.HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT;
  if (!pluginRoot || process.platform !== "win32") {
    t.skip("requires an explicitly selected verified Windows file-image fixture");
    return;
  }
  const { root } = fixture(t);
  const source = path.join(root, "source");
  const journal = path.join(root, "journal");
  fs.mkdirSync(source);
  fs.mkdirSync(journal);
  const file = path.join(source, "example.txt");
  const events = [];
  const options = {
    pluginRoot,
    onProcess: (event) => {
      events.push(event);
      t.diagnostic(JSON.stringify(event));
    },
  };
  let identity = { rootIdentity: "", ancestorIdentities: [] };
  const phases = [
    { before: absentImage(), after: fileImage(""), operation: "create" },
    { before: fileImage(""), after: fileImage("changed"), operation: "edit" },
    { before: fileImage("changed"), after: fileImage("changed", 0o444), operation: "mode" },
    { before: fileImage("changed", 0o444), after: fileImage("changed"), operation: "mode" },
    { before: fileImage("changed"), after: absentImage(), operation: "delete" },
  ];
  try {
    for (const phase of phases) {
      const effect = { root: source, ...identity, path: "example.txt", before: phase.before, after: phase.after, maxBytes: 64 };
      const preflight = await invokeWorkerFileEffect({ operation: "image-preflight", payload: { effect, journal } }, options);
      assert.equal(preflight.status, "ok");
      assert.equal(preflight.result.status, "supported");
      assert.equal(preflight.result.operation, phase.operation);
      identity = { rootIdentity: preflight.result.rootIdentity, ancestorIdentities: preflight.result.ancestorIdentities };
      Object.assign(effect, identity);
      const applied = await invokeWorkerFileEffect({ operation: "image-apply", payload: { effect, journal } }, options);
      assert.equal(applied.status, "ok");
      assert.equal(applied.result.status, "effect-observed");
      assert.equal(applied.result.dataFlushed, ["create", "edit"].includes(phase.operation));
      if (phase.after.kind === "absent") assert.equal(fs.existsSync(file), false);
      else {
        assert.equal(fs.readFileSync(file).toString("base64"), phase.after.content);
        assert.equal(fs.statSync(file).mode & 0o777, phase.after.mode);
      }
      const inspected = await invokeWorkerFileEffect({ operation: "image-inspect", payload: { effect, journal } }, options);
      assert.equal(inspected.result.status, "postimage-observed");
      assert.equal(inspected.result.completionRecorded, true);
      assert.equal(inspected.result.currentImageDigest, imageDigest(phase.after));
      assert.equal(inspected.result.retryBasisAvailable, false);
      const replay = await invokeWorkerFileEffect({ operation: "image-apply", payload: { effect, journal } }, options);
      assert.equal(replay.status, "error");
      assert.equal(replay.error.code, "FILE_EFFECT_ALREADY_EXISTS");
    }
  } finally {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o666); // Undo only synthetic fixture read-only mode for fixture disposal.
  }
  assert.equal(events.filter((event) => event.type === "spawn").length, 20);
  assert.equal(events.filter((event) => event.type === "exit" && event.cleanupVerified).length, 20);
  for (const event of events.filter((event) => event.type === "spawn")) assert.throws(() => process.kill(event.pid, 0), { code: "ESRCH" });
});

test("real image preflight is nonmutating and a create conflict requires exact no-write retry evidence", async (t) => {
  const pluginRoot = process.env.LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT || process.env.HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT;
  if (!pluginRoot || process.platform !== "win32") {
    t.skip("requires an explicitly selected verified Windows file-image fixture");
    return;
  }
  const { root } = fixture(t);
  const source = path.join(root, "source");
  const journal = path.join(root, "journal");
  fs.mkdirSync(source);
  const file = path.join(source, "example.txt");
  const events = [];
  const options = {
    pluginRoot,
    onProcess: (event) => {
      events.push(event);
      t.diagnostic(JSON.stringify(event));
    },
  };
  const unbound = { root: source, rootIdentity: "", ancestorIdentities: [], path: "example.txt", before: absentImage(), after: fileImage(""), maxBytes: 64 };
  const mode = await invokeWorkerFileEffect(
    { operation: "image-preflight", payload: { effect: { ...unbound, after: fileImage("", 0o644) }, journal } },
    options,
  );
  assert.equal(mode.result.status, "unsupported");
  assert.equal(mode.result.reason, "mode-not-representable");
  const parent = await invokeWorkerFileEffect(
    { operation: "image-preflight", payload: { effect: { ...unbound, path: "missing/example.txt" }, journal } },
    options,
  );
  assert.equal(parent.result.status, "unsupported");
  assert.equal(parent.result.reason, "missing-parent-directory");
  const preflight = await invokeWorkerFileEffect({ operation: "image-preflight", payload: { effect: unbound, journal } }, options);
  assert.equal(preflight.result.status, "supported");
  assert.deepEqual(fs.readdirSync(source), []);
  assert.equal(fs.existsSync(journal), false);
  const effect = { ...unbound, rootIdentity: preflight.result.rootIdentity, ancestorIdentities: preflight.result.ancestorIdentities };
  fs.mkdirSync(journal);
  fs.writeFileSync(file, "concurrent fixture edit", { flag: "wx" });
  const rejected = await invokeWorkerFileEffect({ operation: "image-apply", payload: { effect, journal } }, options);
  assert.equal(rejected.status, "error");
  assert.equal(rejected.error.code, "FILE_EFFECT_ALREADY_EXISTS");
  assert.equal(rejected.result.status, "not-started");
  const notReady = await invokeWorkerFileEffect({ operation: "image-retry", payload: { effect, journal } }, options);
  assert.equal(notReady.status, "error");
  assert.equal(notReady.error.code, "FILE_EFFECT_CONFLICT");
  assert.equal(fs.readFileSync(file, "utf8"), "concurrent fixture edit");
  fs.unlinkSync(file); // Explicit synthetic editor restores absence; bridge never repairs a conflicting image.
  const inspected = await invokeWorkerFileEffect({ operation: "image-inspect", payload: { effect, journal } }, options);
  assert.equal(inspected.result.noWriteRecorded, true);
  assert.equal(inspected.result.retryBasisAvailable, true);
  assert.equal(inspected.result.currentImageDigest, imageDigest(absentImage()));
  const retried = await invokeWorkerFileEffect({ operation: "image-retry", payload: { effect, journal } }, options);
  assert.equal(retried.status, "ok");
  assert.notEqual(retried.result.intentId, rejected.result.intentId);
  const retained = JSON.parse(fs.readFileSync(path.join(journal, `${retried.result.intentId}.intent.json`), "utf8"));
  assert.equal(retained.previousIntentId, rejected.result.intentId);
  assert.equal(fs.statSync(file).size, 0);
  const again = await invokeWorkerFileEffect({ operation: "image-retry", payload: { effect, journal } }, options);
  assert.equal(again.status, "error");
  assert.equal(fs.statSync(file).size, 0);
  assert.equal(events.filter((event) => event.type === "spawn").length, 8);
  assert.equal(events.filter((event) => event.type === "exit" && event.cleanupVerified).length, 8);
  for (const event of events.filter((event) => event.type === "spawn")) assert.throws(() => process.kill(event.pid, 0), { code: "ESRCH" });
});

test("real initial prepublication proof binds the exact native request and never reclassifies an existing intent", async (t) => {
  const pluginRoot = process.env.LODE_AGENT_FILE_EFFECT_FIXTURE_ROOT || process.env.HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT;
  if (!pluginRoot || process.platform !== "win32") {
    t.skip("requires an explicitly selected verified Windows prepublication fixture");
    return;
  }
  const { root } = fixture(t);
  const source = path.join(root, "source&scope");
  const journal = path.join(root, "journal");
  const nested = path.join(source, "nested");
  const retainedNested = path.join(source, "retained-nested");
  for (const selected of [nested, retainedNested]) assert(!path.relative(root, selected).startsWith(".."));
  fs.mkdirSync(source);
  fs.mkdirSync(nested);
  fs.mkdirSync(journal);
  const events = [];
  const options = {
    pluginRoot,
    onProcess: (event) => {
      events.push(event);
      t.diagnostic(JSON.stringify(event));
    },
  };
  const effect = {
    root: source,
    rootIdentity: "",
    ancestorIdentities: [],
    path: "nested/example.txt",
    before: absentImage(),
    after: fileImage("created"),
    maxBytes: 64,
  };
  const preflight = await invokeWorkerFileEffect({ operation: "image-preflight", payload: { effect, journal } }, options);
  Object.assign(effect, { rootIdentity: preflight.result.rootIdentity, ancestorIdentities: preflight.result.ancestorIdentities });
  const failedHandle = prepareWorkerFileEffectInvocation(
    { operation: "image-apply", requestId: "synthetic-initial-one", payload: { effect, journal } },
    options,
  );
  fs.renameSync(nested, retainedNested);
  fs.mkdirSync(nested); // A synthetic concurrent editor replaces only its own empty directory.
  const failed = await invokePreparedWorkerFileEffect(failedHandle);
  assert.equal(failed.response.status, "error");
  assert.equal(failed.response.result.intentPublication, "not-attempted");
  const verified = verifyWorkerFileEffectTerminalProof(failed.terminalProof, {
    expectedBinding: failedHandle.binding,
    expectedResponse: failed.response,
    effect,
    requireLive: true,
  });
  assert.equal(verified.provenance, "verified-native-child");
  assert.equal(verified.initialIntentNotAttempted, true);
  assert.equal(failed.response.result.intentId, workerFileEffectNativeIntentId(effect));
  assert.deepEqual(fs.readdirSync(journal), []);
  assert.deepEqual(fs.readdirSync(nested), []);
  fs.rmdirSync(nested);
  fs.renameSync(retainedNested, nested); // Explicit fixture restoration, not bridge retry/repair.
  const successfulHandle = prepareWorkerFileEffectInvocation(
    { operation: "image-apply", requestId: "synthetic-initial-two", payload: { effect, journal } },
    options,
  );
  assert.throws(() => verifyWorkerFileEffectTerminalProof(failed.terminalProof, { expectedBinding: successfulHandle.binding, effect, requireLive: true }));
  const successful = await invokePreparedWorkerFileEffect(successfulHandle);
  assert.equal(successful.response.status, "ok");
  assert.equal(successful.response.result.intentPublication, undefined);
  assert.equal(
    verifyWorkerFileEffectTerminalProof(successful.terminalProof, { expectedBinding: successfulHandle.binding, effect, requireLive: true })
      .initialIntentNotAttempted,
    false,
  );
  assert.equal(fs.readFileSync(path.join(nested, "example.txt"), "utf8"), "created");
  const replayHandle = prepareWorkerFileEffectInvocation(
    { operation: "image-apply", requestId: "synthetic-initial-three", payload: { effect, journal } },
    options,
  );
  const replay = await invokePreparedWorkerFileEffect(replayHandle);
  assert.equal(replay.response.status, "error");
  assert.equal(replay.response.result.intentPublication, undefined);
  assert.equal(
    verifyWorkerFileEffectTerminalProof(replay.terminalProof, { expectedBinding: replayHandle.binding, effect, requireLive: true }).initialIntentNotAttempted,
    false,
  );
  assert.equal(events.filter((event) => event.type === "spawn").length, 4);
  assert.equal(events.filter((event) => event.type === "exit" && event.cleanupVerified).length, 4);
  for (const event of events.filter((event) => event.type === "spawn")) assert.throws(() => process.kill(event.pid, 0), { code: "ESRCH" });
});

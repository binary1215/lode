import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codeMask } from "../scripts/codemods/js-scan.mjs";
import { collectReasonCodes } from "../scripts/codemods/reason-codes.mjs";
import { canonicalJson, canonicalValue, runtimeCanonicalJson, runtimeCanonicalValue } from "../scripts/lib/core/canonical-json.mjs";
import { createHasher, sha256CanonicalJson, sha256Hex, sha256Json } from "../scripts/lib/core/digest.mjs";
import { fail, failCode, failWith, REASON_CODES } from "../scripts/lib/core/errors.mjs";
import { atomicWriteText, renamePath } from "../scripts/lib/core/fs-atomic.mjs";
import { escapesRoot, escapesRootByPrefix } from "../scripts/lib/core/path-safety.mjs";
import { validateInstructionIntegration } from "../scripts/lib/project-instruction-link.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const libRoot = path.join(pluginRoot, "scripts/lib");

function libSources() {
  const files = [];
  (function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (file !== path.join(libRoot, "core")) walk(file);
      } else if (entry.name.endsWith(".mjs")) files.push(file);
    }
  })(libRoot);
  return files;
}

const FORBIDDEN = [
  ["raw createHash(", /(?<![\w$])createHash\(/g],
  ["fs.renameSync(", /(?<![\w$.])fs\.renameSync\(/g],
  ["renameSync imported from node:fs", /import\s*\{[^}]*\brenameSync\b[^}]*\}\s*from\s*"node:fs"/g],
  ["local digest helper", /^(?:export )?(?:async )?function digest\b|^(?:export )?const digest = (?:async )?(?:\(|[\w$]+ =>|function\b)/gm],
];

// distribution-lifecycle serializes its verifier functions with toString() into the
// standalone launcher, which cannot import scripts/lib/core; its sha256() stays inline.
const EXEMPT = new Map([["scripts/lib/distribution-lifecycle.mjs", new Set(["raw createHash("])]]);

// Only executable code counts: source text embedded in strings or templates (for
// example a child-process fixture script) is a separate program.
const inCode = (src, pattern) => {
  const mask = codeMask(src.replace(/^#!.*\n/, (line) => `${" ".repeat(line.length - 1)}\n`));
  return [...src.matchAll(pattern)].filter((match) => mask[match.index]);
};

test("scripts/lib outside core uses the core digest, rename and digest-helper primitives", () => {
  const violations = [];
  for (const file of libSources()) {
    const relative = path.relative(pluginRoot, file).split(path.sep).join("/");
    const src = fs.readFileSync(file, "utf8");
    for (const [label, pattern] of FORBIDDEN) {
      if (inCode(src, pattern).length && !EXEMPT.get(relative)?.has(label)) violations.push(`${relative}: ${label}`);
    }
  }
  assert.deepEqual(violations, []);
  // The exemption stays exact: the launcher still embeds sha256 and the file has no other raw hash.
  const lifecycle = fs.readFileSync(path.join(libRoot, "distribution-lifecycle.mjs"), "utf8");
  assert.match(lifecycle, /sha256\.toString\(\)/);
  assert.equal(inCode(lifecycle, /createHash\(/g).length, 1);
  // The embedded fixture script keeps its own node:crypto hash.
  const lifecycleRuntime = fs.readFileSync(path.join(libRoot, "runtime-invocation-lifecycle.mjs"), "utf8");
  assert.match(lifecycleRuntime, /const inputDigest = crypto\.createHash\('sha256'\)\.update\(input\)\.digest\('hex'\);/);
});

test("REASON_CODES lists exactly the codes used as code/reasonCode values or fail/error call arguments", () => {
  assert.ok(Object.isFrozen(REASON_CODES));
  assert.deepEqual([...REASON_CODES], [...new Set(REASON_CODES)].sort(), "sorted and unique");
  const used = collectReasonCodes();
  const listed = new Set(REASON_CODES);
  assert.deepEqual(
    used.filter((code) => !listed.has(code)),
    [],
    "used but not listed; run: node scripts/codemods/reason-codes.mjs --write",
  );
  assert.deepEqual(
    REASON_CODES.filter((code) => !used.includes(code)),
    [],
    "listed but unused; run: node scripts/codemods/reason-codes.mjs --write",
  );
});

test("digest helpers keep the exact input bytes", () => {
  const reference = (input) => crypto.createHash("sha256").update(input).digest("hex");
  for (const input of ["", "lode", "é\u0000\n", Buffer.from([0, 255, 1]), new Uint8Array([7, 8])]) assert.equal(sha256Hex(input), reference(input));
  // Only the first argument is hashed, so it is safe as a map callback.
  assert.deepEqual(["a", "b"].map(sha256Hex), [reference("a"), reference("b")]);
  assert.equal(sha256Json({ b: 1, a: [2] }), reference('{"b":1,"a":[2]}'));
  assert.equal(sha256CanonicalJson({ b: 1, a: { d: 2, c: 3 } }), reference('{"a":{"c":3,"d":2},"b":1}'));
  assert.equal(createHasher("sha256").update("a").update("b").digest("hex"), reference("ab"));
  assert.equal(createHasher("sha1").update("x").digest("hex"), crypto.createHash("sha1").update("x").digest("hex"));
  assert.throws(() => sha256Json(undefined), { code: "ERR_INVALID_ARG_TYPE" });
});

test("the two canonical normalizers sort object keys recursively and keep arrays in order", () => {
  const value = { b: [{ z: 1, y: null }], a: "x", C: true };
  const expected = '{"C":true,"a":"x","b":[{"y":null,"z":1}]}';
  for (const [normalize, json] of [
    [canonicalValue, canonicalJson],
    [runtimeCanonicalValue, runtimeCanonicalJson],
  ]) {
    assert.equal(JSON.stringify(normalize(value)), expected);
    assert.equal(json(value), expected);
    assert.equal(normalize(null), null);
    assert.equal(json([3, 1]), "[3,1]");
  }
});

test("fail helpers throw the message and reason code of the local helpers they replaced", () => {
  assert.throws(
    () => fail("Bad input.", "SOME_CODE"),
    (error) => error instanceof Error && error.message === "Bad input." && error.code === "SOME_CODE",
  );
  const moduleFail = failWith("MODULE_ERROR");
  assert.throws(() => moduleFail("Default."), { message: "Default.", code: "MODULE_ERROR" });
  assert.throws(() => moduleFail("Specific.", "SPECIFIC_CODE"), { message: "Specific.", code: "SPECIFIC_CODE" });
  assert.throws(() => moduleFail("Undefined keeps the default.", undefined), { code: "MODULE_ERROR" });
  assert.throws(() => failCode("ONLY_CODE"), { message: "ONLY_CODE", code: "ONLY_CODE" });
  assert.throws(() => failCode("WITH_MESSAGE", "Readable."), { message: "Readable.", code: "WITH_MESSAGE" });
  // project-instruction-link used fail(code, message); its calls now pass (message, code).
  assert.throws(() => validateInstructionIntegration("copy"), {
    message: "Instruction integration must be link or preserve.",
    code: "PROJECT_INSTRUCTION_CHOICE_INVALID",
  });
});

test("path-escape predicates keep the prefix and segment forms distinct", () => {
  for (const outside of ["..", `..${path.sep}x`, path.resolve("/abs")]) {
    assert.equal(escapesRoot(outside), true, outside);
    assert.equal(escapesRootByPrefix(outside), true, outside);
  }
  for (const inside of ["", "x", `x${path.sep}y`]) {
    assert.equal(escapesRoot(inside), false, inside);
    assert.equal(escapesRootByPrefix(inside), false, inside);
  }
  assert.equal(escapesRoot("..data"), false);
  assert.equal(escapesRootByPrefix("..data"), true);
});

test("atomicWriteText and renamePath publish without leaving staging files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-core-fs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "nested", "record.json");
  atomicWriteText(file, "first\n");
  atomicWriteText(file, "second\n");
  assert.equal(fs.readFileSync(file, "utf8"), "second\n");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["record.json"]);
  renamePath(file, path.join(root, "moved.json"));
  assert.equal(fs.readFileSync(path.join(root, "moved.json"), "utf8"), "second\n");
  assert.throws(() => renamePath(file, path.join(root, "again.json")), { code: "ENOENT" });
});

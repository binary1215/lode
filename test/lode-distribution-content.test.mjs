import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyMarketplaceContent } from "../scripts/lib/distribution/marketplace-content.mjs";
import { stageDistributionRelease } from "../scripts/lib/distribution/distribution-lifecycle.mjs";
import { buildCodexMarketplaceSnapshot, verifyCodexMarketplaceSnapshot } from "../scripts/lib/distribution/codex-marketplace.mjs";
import { buildClaudeMarketplaceSnapshot, verifyClaudeMarketplaceSnapshot } from "../scripts/lib/distribution/claude-marketplace.mjs";

const source = path.resolve(import.meta.dirname, "..");
const contamination = { code: "LODE_MARKETPLACE_CONTENT_CONTAMINATION" };
function fixture(t) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, "lode-distribution-content-")));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert(path.basename(root).startsWith("lode-distribution-content-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 100 });
  });
  return root;
}
function write(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function inventory(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const file = path.join(entry.parentPath, entry.name);
    return [path.relative(root, file), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")];
  }).sort(([a], [b]) => a.localeCompare(b));
}

test("content check permits portable configuration and documented absolute-path examples", t => {
  const root = fixture(t);
  const files = ["scripts/example.mjs", "hooks/example.json", "docs/example.md", "skills/example/SKILL.md", "skills/lode-agent-core/scripts/helper.mjs", "hooks/docs/local.json"];
  write(root, files[0], String.raw`const roots = ["C:\\path\\to\\project", "C:/temporary/output", "/tmp/project", "/home/<user>/project", "/home/$USER/project", "/Users/${"${USER}"}/project", "C:\\Users\\%USERNAME%\\project", "https://example.com/home/alice/project", "relative/home/alice/project"];`);
  write(root, files[1], JSON.stringify({ root: "${CLAUDE_PLUGIN_ROOT}", schema: { projectId: { type: "string" }, sessionId: { type: "string" } } }));
  const prose = 'Examples: /home/alice/project, C:\\Users\\alice\\project.\n```json\n{"schemaVersion":1,"sessionId":"session-12345678-1234-1234-1234-123456789abc","mode":"session","currentWholePlanId":null,"activeRunId":null,"latestCheckpoint":null,"updatedAt":"2026-01-01T00:00:00Z"}\n```\n';
  write(root, files[2], prose);
  write(root, files[3], prose);
  write(root, files[4], 'export const root = "/home/$USER/project";\n');
  write(root, files[5], JSON.stringify({ root: "/home/<user>/project" }));
  const before = inventory(root);
  verifyMarketplaceContent({ root, files });
  assert.deepEqual(inventory(root), before, "Content verification is read-only");
});

test("content check rejects concrete personal home paths only in executable/config surfaces", t => {
  const root = fixture(t);
  for (const value of ["C:/Users/fixture-person/private/project", String.raw`C:\Users\fixture-person\private\project`, "/home/fixture-person/project", "/Users/fixture-person/project", "file:///home/fixture-person/project"]) {
    for (const file of ["scripts/example.mjs", "hooks/example.json", "skills/lode-agent-core/scripts/helper.mjs", "hooks/docs/local.json"]) {
      write(root, file, file.endsWith(".mjs") ? `export const root = ${JSON.stringify(value)};\n` : JSON.stringify({ root: value }));
      assert.throws(() => verifyMarketplaceContent({ root, files: [file] }), error => {
        assert.equal(error.code, contamination.code);
        assert(error.message.includes(file));
        assert(!error.message.includes("fixture-person"), "Diagnostics must not echo the leaked path");
        return true;
      });
    }
  }
});

test("standalone JSON checks concrete runtime records, not identifiers or schema vocabulary alone", t => {
  const root = fixture(t), file = "hooks/example.json";
  const sessionId = "session-12345678-1234-1234-1234-123456789abc";
  const projectId = `lode-${"a".repeat(20)}`;
  for (const record of [
    { schemaVersion: 1, projectId, projectRoot: "/tmp/project", createdAt: "2026-01-01T00:00:00Z", runtimes: ["codex"], integrations: {} },
    { schemaVersion: 1, sessionId, mode: "session", currentWholePlanId: null, activeRunId: null, latestCheckpoint: null, updatedAt: "2026-01-01T00:00:00Z" },
  ]) {
    write(root, file, JSON.stringify({ nested: [record] }));
    assert.throws(() => verifyMarketplaceContent({ root, files: [file] }), contamination);
  }
  for (const legal of [
    { schemaVersion: 1, sessionId, mode: "session" },
    { schemaVersion: 1, sessionId: [sessionId], mode: "session", currentWholePlanId: null, activeRunId: null, latestCheckpoint: null, updatedAt: "2026-01-01T00:00:00Z" },
    { schemaVersion: 1, projectId: "<project-id>", projectRoot: "/tmp/project", createdAt: "<timestamp>", runtimes: [], integrations: {} },
    { type: "object", properties: { schemaVersion: { const: 1 }, projectId: { type: "string" }, sessionId: { type: "string" } } },
  ]) {
    write(root, file, JSON.stringify(legal));
    verifyMarketplaceContent({ root, files: [file] });
  }
  write(root, file, `${"[".repeat(10000)}null${"]".repeat(10000)}`);
  verifyMarketplaceContent({ root, files: [file] });
});

for (const [provider, build, verify] of [
  ["codex", buildCodexMarketplaceSnapshot, verifyCodexMarketplaceSnapshot],
  ["claude", buildClaudeMarketplaceSnapshot, verifyClaudeMarketplaceSnapshot],
]) {
  for (const identity of ["lode", "head"]) {
    test(`${provider}/${identity} applies the same content check after integrity checks without shipping fixtures`, t => {
      const root = fixture(t), fixtureSource = path.join(root, "source");
      stageDistributionRelease({ sourceRoot: source, destinationRoot: fixtureSource });
      const options = { sourceRoot: fixtureSource, name: `${identity}-agent-plugin` };
      const cleanRoot = path.join(root, "clean");
      const built = build({ ...options, outputRoot: cleanRoot });
      const before = inventory(cleanRoot);
      assert.deepEqual(verify({ root: cleanRoot }), built);
      assert.deepEqual(inventory(cleanRoot), before);
      assert(!fs.existsSync(path.join(cleanRoot, "plugins", built.pluginName, "test")));

      // A producer can hash a leak correctly; byte integrity alone must not bless it.
      const codeFile = path.join(fixtureSource, "scripts/lode.mjs");
      const original = fs.readFileSync(codeFile);
      fs.appendFileSync(codeFile, '\n// local checkout: /home/fixture-person/private/project\n');
      const badCodeRoot = path.join(root, "bad-code");
      assert.throws(() => build({ ...options, outputRoot: badCodeRoot }), contamination);
      assert(!fs.existsSync(badCodeRoot));
      fs.writeFileSync(codeFile, original);

      write(fixtureSource, "hooks/runtime-record.json", JSON.stringify({
        schemaVersion: 1, sessionId: "session-12345678-1234-1234-1234-123456789abc", mode: "session",
        currentWholePlanId: null, activeRunId: null, latestCheckpoint: null, updatedAt: "2026-01-01T00:00:00Z",
      }));
      const badRecordRoot = path.join(root, "bad-record");
      assert.throws(() => build({ ...options, outputRoot: badRecordRoot }), contamination);
      assert(!fs.existsSync(badRecordRoot));
      assert(!fs.readdirSync(root).some(entry => /\.stage-/.test(entry)), "Failed producers clean their exact temporary stage");
      assert.deepEqual(inventory(cleanRoot), before, "A failed sibling build cannot mutate verified output");
    });
  }
}

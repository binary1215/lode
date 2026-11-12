import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCodexMarketplaceSnapshot } from "../scripts/lib/distribution/codex-marketplace.mjs";
import { buildClaudeMarketplaceSnapshot } from "../scripts/lib/distribution/claude-marketplace.mjs";
import { BUILD_RECIPE, RELEASE_ASSETS, comparePublicationVersions, decideMarketplacePublication, decideReleasePublication, logicalPublicationDigest, publicationGithub, readPublicationSnapshot } from "../scripts/lib/distribution/publication-version.mjs";
import { previousPublicationRepository, readPreviousPublication } from "../legacy/marketplace-ownership/publication.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
const row = (file, value) => ({ path: file, bytes: Buffer.byteLength(value), sha256: crypto.createHash("sha256").update(value).digest("hex") });
const files = [row("scripts/runtime.mjs", "runtime"), row("native/worker/main.go", "source"), row("dist/linux-x64/worker", "binary")];
const digest = overrides => logicalPublicationDigest({ files, recipe: Buffer.from("recipe"), nativeTargetCount: 5, ...overrides });
const candidate = overrides => ({ provider: "codex", marketplaceName: "lode-agent-plugin", pluginName: "lode-agent-core", sourceRepository: "binary1215/lode", sourceCommit: b, pluginVersion: "0.3.0-beta.48", logicalDigest: digest(), ...overrides });

test("semantic version precedence blocks downgrade, alias/build metadata reuse, invalid versions", () => {
  assert.equal(comparePublicationVersions("0.3.0-beta.10", "0.3.0-beta.9"), 1);
  assert.equal(comparePublicationVersions("0.3.0", "0.3.0-beta.999"), 1);
  assert.equal(comparePublicationVersions("0.3.0-beta.a", "0.3.0-beta.999"), 1);
  assert.equal(comparePublicationVersions("0.3.0-beta", "0.3.0-beta.1"), -1);
  for (const value of ["0.03.0", "0.3.0-beta.01", "v0.3.0", "junk"]) assert.throws(() => comparePublicationVersions(value, "0.3.0"));
  assert.throws(() => decideMarketplacePublication({ candidate: candidate({ pluginVersion: "0.3.0-beta.47" }), previous: candidate() }), /downgrade/);
  assert.throws(() => decideMarketplacePublication({ candidate: candidate({ pluginVersion: "0.3.0-beta.48+new" }), previous: candidate() }), /metadata/);
});

test("same-version source, Go source, recipe and native target changes require a new version", () => {
  const previous = candidate({ sourceCommit: a });
  for (const logicalDigest of [digest({ files: [row("scripts/runtime.mjs", "changed"), files[1]] }),
    digest({ files: [files[0], row("native/worker/main.go", "changed")] }), digest({ recipe: Buffer.from("new toolchain/flags") }),
    digest({ nativeTargetCount: 0 }), null]) {
    assert.throws(() => decideMarketplacePublication({ candidate: candidate({ logicalDigest }), previous }), /different or unknown/);
  }
  assert.throws(() => digest({ files: [files[0]] }), /native source missing/);
  assert.throws(() => digest({ recipe: null }), /unknown/);
});

test("same logical inputs with new commit/rebuild metadata converge without writes or ref replacement", () => {
  const rebuilt = digest({ files: [files[0], files[1], row("dist/linux-x64/worker", "new nondeterministic bytes"), row("dist/BUILD-METADATA.json", b)] });
  assert.equal(rebuilt, digest());
  const previous = Object.freeze(candidate({ sourceCommit: a }));
  const before = JSON.stringify(previous);
  const result = decideMarketplacePublication({ candidate: candidate({ logicalDigest: rebuilt }), previous, tagCommit: a });
  assert.deepEqual(result, { action: "already_published", write: false, preservedSourceCommit: a });
  assert.equal(JSON.stringify(previous), before);
  let branchWrites = 0;
  if (result.action === "publish") branchWrites++;
  assert.equal(branchWrites, 0);
  assert.throws(() => decideMarketplacePublication({ candidate: candidate(), previous, tagCommit: c }), /another source/);
});

test("higher version advances verified old snapshots without equivalence proof but cannot resurrect an old tag", () => {
  const previous = candidate({ pluginVersion: "0.3.0-beta.47", logicalDigest: null, sourceCommit: a });
  assert.deepEqual(decideMarketplacePublication({ candidate: candidate({ logicalDigest: null }), previous }), { action: "publish", write: true });
  assert.throws(() => decideMarketplacePublication({ candidate: candidate(), previous, tagCommit: a }), /another source/);
  assert.throws(() => decideMarketplacePublication({ candidate: candidate(), previous: { ...previous, provider: "claude" } }), /identity/);
});

test("complete release retry is no-write; tag conflict, partial and unknown provenance preserve old assets", () => {
  const release = { id: 123, tag_name: "v0.3.0-beta.48", draft: false, body: `Source commit: \`${b}\``, assets: RELEASE_ASSETS.map(name => ({ name, size: 42, digest: `sha256:${"a".repeat(64)}` })) };
  const args = { version: "0.3.0-beta.48", sourceCommit: b, tagCommit: b };
  const before = JSON.stringify(release);
  assert.deepEqual(decideReleasePublication(args), { action: "publish", write: true });
  assert.deepEqual(decideReleasePublication({ ...args, release }), { action: "already_published", write: false, releaseId: 123 });
  assert.equal(JSON.stringify(release), before);
  assert.throws(() => decideReleasePublication({ ...args, tagCommit: a }), /differs/);
  for (const changed of [{ ...release, assets: release.assets.slice(1) }, { ...release, body: "unknown" }, { ...release, draft: true }, { ...release, assets: release.assets.map(asset => ({ ...asset, digest: null })) }]) {
    assert.throws(() => decideReleasePublication({ ...args, release: changed }));
  }
});

test("four real provider/identity snapshots are separately verified, read-only and tamper checked", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lode-publication-test-"));
  try {
    for (const provider of ["codex", "claude"]) for (const identity of ["lode", "head"]) {
      const root = path.join(tmp, `${provider}-${identity}`), name = `${identity}-agent-plugin`;
      const repository = identity === "head" ? "binary1215/head-agent-plugin" : "binary1215/lode";
      const build = provider === "codex" ? buildCodexMarketplaceSnapshot : buildClaudeMarketplaceSnapshot;
      build({ sourceRoot, outputRoot: root, name, repository, commit: a });
      const snapshot = readPublicationSnapshot({ root, provider, repository, marketplaceName: name });
      assert.equal(snapshot.sourceCommit, a);
      assert.equal(snapshot.pluginName, `${identity}-agent-core`);
      assert.ok(snapshot.files.some(file => file.path.startsWith("native/") && file.path.endsWith(".go")));
      for (const excluded of ["scripts/verify-publication-version.mjs", "scripts/lib/distribution/publication-version.mjs", "legacy/marketplace-ownership/publication.mjs"]) {
        assert.equal(snapshot.files.some(file => file.path === excluded), false);
        assert.equal(fs.existsSync(path.join(root, "plugins", snapshot.pluginName, excluded)), false);
      }
      if (identity === "head") {
        assert.throws(() => readPublicationSnapshot({ root, provider, repository: "binary1215/lode", marketplaceName: name }));
        const snapshotCommit = provider === "codex" ? "d0b9b6bee9e6aaed5c76de1c881520067d61e985" : "d22c0e04a8bcaf83814f452fb69ae99a13de8f0a";
        const previous = readPreviousPublication({ root, provider, repository: "binary1215/lode", marketplaceName: name, snapshotCommit });
        assert.equal(previous.previousSourceRepository, repository);
        assert.equal(previous.sourceRepository, "binary1215/lode");
        assert.deepEqual(decideMarketplacePublication({ previous, candidate: { ...previous, pluginVersion: "99.0.0", sourceCommit: b } }), { action: "publish", write: true });
        assert.throws(() => decideMarketplacePublication({ previous, candidate: { ...previous, sourceCommit: b } }), /unknown/);
      }
      const manifest = path.join(root, "plugins", snapshot.pluginName, "package.json");
      fs.appendFileSync(manifest, "tamper");
      assert.throws(() => readPublicationSnapshot({ root, provider, repository, marketplaceName: name }));
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("GitHub proof uses fixed origin, peels tags, verifies recipe blob, and bounds failures without leaking tokens", async () => {
  const recipe = Buffer.from("exact build recipe");
  const sha = crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${recipe.length}\0`), recipe])).digest("hex");
  const requests = [];
  const api = publicationGithub({ repository: "binary1215/lode", token: "synthetic-secret", fetchImpl: async (url, options) => {
    requests.push({ url, options });
    const value = url.includes("git/ref/") ? { object: { type: "tag", sha: a } }
      : url.includes("git/tags/") ? { object: { type: "commit", sha: b } }
        : { size: recipe.length, sha, encoding: "base64", content: recipe.toString("base64") };
    return new Response(JSON.stringify(value));
  } });
  assert.equal(await api.tag("0.3.0-beta.48"), b);
  assert.deepEqual(await api.recipe(a), recipe);
  assert.ok(requests.every(item => item.url.startsWith("https://api.github.com/repos/binary1215/lode/") && item.options.redirect === "error"));
  assert.throws(() => publicationGithub({ repository: "https://evil.invalid" }));
  const denied = publicationGithub({ repository: "binary1215/lode", fetchImpl: async () => new Response("secret", { status: 403 }) });
  await assert.rejects(denied.tag("0.3.0"), /unavailable \(403\)/);
  const missing = publicationGithub({ repository: "binary1215/lode", fetchImpl: async () => new Response("", { status: 404 }) });
  assert.equal(await missing.tag("0.3.0"), null);
  await assert.rejects(missing.recipe(a), /unknown/);
  const oversized = publicationGithub({ repository: "binary1215/lode", fetchImpl: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(oversized.tag("0.3.0"), /bounded/);
});

test("workflow publication is write-gated on publish, with release serialization and separate four identities", () => {
  const workflow = fs.readFileSync(path.join(sourceRoot, BUILD_RECIPE), "utf8");
  assert.equal((workflow.match(/id: publication/g) || []).length, 3);
  assert.equal((workflow.match(/if: \$\{\{ steps\.publication\.outputs\.action == 'publish' \}\}/g) || []).length, 5);
  assert.match(workflow, /group: immutable-release-\$\{\{ needs\.prepare\.outputs\.release_tag \}\}/);
  assert.match(workflow, /--provider codex --root/);
  assert.match(workflow, /--provider claude --root/);
  assert.match(workflow, /--force-with-lease="refs\/heads\/\$\{MARKETPLACE_BRANCH\}:\$\{EXPECTED_SHA\}"/);
});

test("historical ownership exceptions remain exact HEAD predecessor-only and never bless unknown snapshots", () => {
  const args = { provider: "codex", repository: "binary1215/lode", marketplaceName: "head-agent-plugin", snapshotCommit: "d0b9b6bee9e6aaed5c76de1c881520067d61e985" };
  assert.equal(previousPublicationRepository(args), "binary1215/head-agent-plugin");
  assert.equal(previousPublicationRepository({ ...args, snapshotCommit: a }), "binary1215/lode");
  for (const change of [{ marketplaceName: "lode-agent-plugin" }, { repository: "someone/else" }, { provider: "unknown" }, { snapshotCommit: "" }]) {
    assert.throws(() => previousPublicationRepository({ ...args, ...change }), /exact/);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lode-previous-publication-test-"));
  try { assert.throws(() => readPreviousPublication({ ...args, root: tmp })); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.throws(() => logicalPublicationDigest({ files: null, recipe: Buffer.from("known"), nativeTargetCount: 5 }), /unknown/);
});

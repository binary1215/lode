import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { derivedFixture, sourceThread } from "./helpers/derived-history-fixture.mjs";
import { prepareProjectNativeHistory } from "../scripts/lib/project-native-derivation.mjs";
import { publishClaudeDerived } from "../scripts/lib/claude-derived-publication.mjs";

test("prepared artifacts freeze metadata and callbacks; clones cannot enter publication", async t => {
  const f = await derivedFixture(t);
  const artifact = prepareProjectNativeHistory({ bundleRoot: f.bundleRoot, root: f.f.root, threadIds: [sourceThread] });
  for (const change of [
    () => { artifact.manifest.target.nativeId = sourceThread; },
    () => { artifact.manifest.input.source.nativePayloadDigest = "0".repeat(64); },
    () => { artifact.digest = "0".repeat(64); },
    () => { artifact.check = () => {}; },
    () => { artifact.recheck = () => {}; },
    () => { artifact.rows[0].message.role = "system"; },
    () => { artifact.mapping[0].targetMessageIndex = 999; },
  ]) assert.throws(change, TypeError);
  artifact.recheck();
  const nativeHome = path.join(f.f.base, "prepared-native-home"); fs.mkdirSync(nativeHome);
  await assert.rejects(publishClaudeDerived({ artifact: { ...artifact }, nativeHome, root: f.f.root, host: {} }),
    { code: "DERIVED_INSPECTED_ARTIFACT_REQUIRED" });
  const serialized = JSON.parse(JSON.stringify({ manifest: artifact.manifest, digest: artifact.digest }));
  await assert.rejects(publishClaudeDerived({ artifact: serialized, nativeHome, root: f.f.root, host: {} }),
    { code: "DERIVED_INSPECTED_ARTIFACT_REQUIRED" });
  assert.deepEqual(fs.readdirSync(nativeHome), []);
});

test("prepared artifact recheck verifies detached transcript Buffer bytes as well as files", async t => {
  const f = await derivedFixture(t);
  const artifact = prepareProjectNativeHistory({ bundleRoot: f.bundleRoot, root: f.f.root, threadIds: [sourceThread] });
  assert.ok(Buffer.isBuffer(artifact.raw));
  artifact.raw[0] ^= 1;
  assert.throws(() => artifact.recheck(), { code: "DERIVED_ARTIFACT_TAMPER" });
});

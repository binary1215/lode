#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCodexMarketplaceSnapshot, verifyCodexMarketplaceSnapshot } from "./lib/codex-marketplace.mjs";
import { ARTIFACT_COMPOSITION } from "./lib/lode-artifact-composition.mjs";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const rootIndex = process.argv.indexOf("--root");
const providedRoot = rootIndex === -1 ? "" : process.argv[rootIndex + 1] || "";
const repositoryIndex = process.argv.indexOf("--expected-repository");
const expectedRepository = repositoryIndex === -1 ? null : process.argv[repositoryIndex + 1] || "";
const marketplaceIndex = process.argv.indexOf("--expected-marketplace-name");
const expectedMarketplaceName = marketplaceIndex === -1 ? null : process.argv[marketplaceIndex + 1] || "";
const allowLegacyBytePreservation = process.argv.includes("--allow-legacy-byte-preservation");
const allowLegacyInterfaceForOwnership = process.argv.includes("--allow-legacy-interface-for-ownership");
const requireNativeBundle = process.argv.includes("--require-native");

if (providedRoot) {
  process.stdout.write(`${JSON.stringify(verifyCodexMarketplaceSnapshot({
    root: path.resolve(providedRoot),
    expectedRepository,
    expectedMarketplaceName,
    allowLegacyBytePreservation,
    allowLegacyInterfaceForOwnership,
    requireNativeBundle,
  }), null, 2)}\n`);
} else {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lode-agent-codex-marketplace-"));
  const snapshotRoot = path.join(temporaryRoot, "snapshot");
  try {
    const built = buildCodexMarketplaceSnapshot({ sourceRoot: path.resolve("."), outputRoot: snapshotRoot });
    const verified = verifyCodexMarketplaceSnapshot({ root: snapshotRoot });
    assert.deepEqual(verified, built);
    const carrierRoot = path.join(temporaryRoot, "legacy-carrier");
    const carrier = buildCodexMarketplaceSnapshot({ sourceRoot: path.resolve("."), outputRoot: carrierRoot, name: "head-agent-plugin" });
    assert.equal(carrier.marketplaceName, "head-agent-plugin");
    assert.equal(carrier.pluginName, "head-agent-core");
    const carrierPluginRoot = path.join(carrierRoot, "plugins", carrier.pluginName);
    assert.equal(JSON.parse(fs.readFileSync(path.join(carrierPluginRoot, "package.json"), "utf8")).name, "@local/head-agent-core-plugin");
    assert.equal(JSON.parse(fs.readFileSync(path.join(carrierRoot, ".head-agent-marketplace-generated.json"), "utf8")).kind, "HeadAgentCodexMarketplaceSnapshot");
    assert.equal(fs.existsSync(path.join(carrierRoot, ".lode-agent-marketplace-generated.json")), false);
    const skillFiles = ["SKILL.md", "references/runtime-composition.md", "references/conversation-ux.md", "references/authority-and-roles.md"];
    for (const file of skillFiles) {
      const relative = path.join("skills", ARTIFACT_COMPOSITION.skills.core, file);
      assert.deepEqual(fs.readFileSync(path.join(snapshotRoot, "plugins", built.pluginName, relative)),
        fs.readFileSync(path.resolve(relative)), `Generated Codex skill bytes differ: ${file}`);
    }
    assert.equal(fs.existsSync(path.join(snapshotRoot, "plugins", built.pluginName, "test")), false);
    assert.equal(fs.existsSync(path.join(snapshotRoot, "plugins", built.pluginName, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(snapshotRoot, "plugins", built.pluginName, ".git")), false);
    assert.equal(fs.existsSync(path.join(snapshotRoot, "plugins", built.pluginName, "legacy")), false);
    const runtimeManifest = JSON.parse(fs.readFileSync(path.join(snapshotRoot, "plugins", built.pluginName, "distribution-manifest.json"), "utf8"));
    const conversationSkill = `skills/${ARTIFACT_COMPOSITION.skills.conversation}/SKILL.md`;
    const conversationBytes = fs.readFileSync(path.resolve(conversationSkill));
    assert.deepEqual(fs.readFileSync(path.join(snapshotRoot, "plugins", built.pluginName, conversationSkill)), conversationBytes);
    const conversationEntry = runtimeManifest.files.find(file => file.path === conversationSkill);
    assert.ok(conversationEntry, "The new conversation Skill must be packaged, not just linked");
    assert.equal(conversationEntry.sha256, sha256(conversationBytes));
    assert.equal(conversationEntry.bytes, conversationBytes.length);
    assert.equal(runtimeManifest.files.some((file) => file.path === "legacy" || file.path.startsWith("legacy/")), false);
    assert.equal(fs.readFileSync(path.join(snapshotRoot, "plugins", built.pluginName, "LICENSE"), "utf8").startsWith("MIT License\n"), true);
    const pluginManifestFile = path.join(snapshotRoot, "plugins", built.pluginName, ".codex-plugin", "plugin.json");
    const pluginManifestBytes = fs.readFileSync(pluginManifestFile, "utf8");
    assert.equal(JSON.parse(pluginManifestBytes).license, "MIT");
    assert.equal(JSON.parse(pluginManifestBytes).hooks, "./hooks/codex.json");
    const startupHooks = JSON.parse(fs.readFileSync(path.join(snapshotRoot, "plugins", built.pluginName, "hooks", "codex.json"), "utf8"));
    assert.deepEqual(Object.keys(startupHooks.hooks), ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop", "SubagentStart", "SubagentStop", "SessionEnd"]);
    assert.match(startupHooks.hooks.SessionStart[0].hooks[0].command, /session-host-hook\.mjs/);
    assert.ok(runtimeManifest.files.some((file) => file.path === "scripts/lib/session-host-adapter.mjs"));
    for (const file of ["scripts/lib/native-session-observations.mjs", "scripts/lib/native-session-process.mjs", "scripts/opencode-plugin.mjs"]) {
      assert.ok(runtimeManifest.files.some(entry => entry.path === file), `Native observer dependency must be packaged: ${file}`);
      assert.deepEqual(fs.readFileSync(path.join(snapshotRoot, "plugins", built.pluginName, file)), fs.readFileSync(path.resolve(file)));
    }

    const legacySnapshotRoot = path.join(temporaryRoot, "legacy-interface-snapshot");
    fs.cpSync(snapshotRoot, legacySnapshotRoot, { recursive: true, errorOnExist: true });
    const legacyPluginRoot = path.join(legacySnapshotRoot, "plugins", built.pluginName);
    const legacyPluginManifestFile = path.join(legacyPluginRoot, ".codex-plugin", "plugin.json");
    const legacyPluginManifest = JSON.parse(fs.readFileSync(legacyPluginManifestFile, "utf8"));
    legacyPluginManifest.interface.defaultPrompt.push("A fourth legacy prompt that the current Codex interface must reject.");
    const legacyPluginManifestBytes = Buffer.from(`${JSON.stringify(legacyPluginManifest, null, 2)}\n`, "utf8");
    fs.writeFileSync(legacyPluginManifestFile, legacyPluginManifestBytes);

    const legacyDistributionFile = path.join(legacyPluginRoot, "distribution-manifest.json");
    const legacyDistribution = JSON.parse(fs.readFileSync(legacyDistributionFile, "utf8"));
    const legacyManifestEntry = legacyDistribution.files.find((file) => file.path === ".codex-plugin/plugin.json");
    assert.ok(legacyManifestEntry);
    legacyManifestEntry.bytes = legacyPluginManifestBytes.byteLength;
    legacyManifestEntry.sha256 = sha256(legacyPluginManifestBytes);
    const legacyDistributionIdentity = {
      protocolVersion: legacyDistribution.protocolVersion,
      name: legacyDistribution.name,
      version: legacyDistribution.version,
      files: legacyDistribution.files,
    };
    legacyDistribution.releaseId = `release-${sha256(Buffer.from(canonical(legacyDistributionIdentity))).slice(0, 24)}`;
    fs.writeFileSync(legacyDistributionFile, `${JSON.stringify(legacyDistribution, null, 2)}\n`, "utf8");

    const legacyMarkerFile = path.join(legacySnapshotRoot, `.${ARTIFACT_COMPOSITION.identity}-agent-marketplace-generated.json`);
    const legacyMarker = JSON.parse(fs.readFileSync(legacyMarkerFile, "utf8"));
    legacyMarker.distributionReleaseId = legacyDistribution.releaseId;
    const legacyMarkerIdentity = { ...legacyMarker };
    delete legacyMarkerIdentity.snapshotId;
    legacyMarker.snapshotId = `codex-marketplace-${sha256(Buffer.from(canonical(legacyMarkerIdentity))).slice(0, 24)}`;
    fs.writeFileSync(legacyMarkerFile, `${JSON.stringify(legacyMarker, null, 2)}\n`, "utf8");

    assert.throws(
      () => verifyCodexMarketplaceSnapshot({ root: legacySnapshotRoot }),
      { code: "HEAD_CODEX_MARKETPLACE_DEFAULT_PROMPTS_INVALID" },
    );
    assert.throws(
      () => verifyCodexMarketplaceSnapshot({ root: legacySnapshotRoot, allowLegacyInterfaceForOwnership: true }),
      { code: "HEAD_CODEX_MARKETPLACE_LEGACY_INTERFACE_SCOPE" },
    );
    const legacyOwnership = verifyCodexMarketplaceSnapshot({
      root: legacySnapshotRoot,
      expectedRepository: "local",
      expectedMarketplaceName: built.marketplaceName,
      allowLegacyInterfaceForOwnership: true,
    });
    assert.equal(legacyOwnership.pluginInterface, "legacy_nonconforming_ownership_only");

    const excessivePrompts = JSON.parse(pluginManifestBytes);
    excessivePrompts.interface.defaultPrompt.push("This fourth prompt must fail closed before Codex silently ignores it.");
    fs.writeFileSync(pluginManifestFile, `${JSON.stringify(excessivePrompts, null, 2)}\n`, "utf8");
    assert.throws(
      () => verifyCodexMarketplaceSnapshot({ root: snapshotRoot }),
      { code: "HEAD_CODEX_MARKETPLACE_DEFAULT_PROMPTS_INVALID" },
    );
    fs.writeFileSync(pluginManifestFile, pluginManifestBytes, "utf8");

    const unexpectedDirectory = path.join(snapshotRoot, "plugins", built.pluginName, "unexpected-empty-directory");
    fs.mkdirSync(unexpectedDirectory);
    assert.throws(
      () => verifyCodexMarketplaceSnapshot({ root: snapshotRoot }),
      { code: "HEAD_CODEX_MARKETPLACE_TREE_MISMATCH" },
    );
    fs.rmdirSync(unexpectedDirectory);

    const catalogFile = path.join(snapshotRoot, ".agents", "plugins", "marketplace.json");
    const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    catalog.plugins[0].source.path = "../outside";
    fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    assert.throws(
      () => verifyCodexMarketplaceSnapshot({ root: snapshotRoot }),
      { code: "HEAD_CODEX_MARKETPLACE_ENTRY_INVALID" },
    );

    process.stdout.write(`${JSON.stringify({
      status: "codex_marketplace_packaging_verified",
      legacyCarrierIdentityVerified: true,
      marketplaceName: built.marketplaceName,
      pluginName: built.pluginName,
      pluginVersion: built.pluginVersion,
      distributionReleaseId: built.distributionReleaseId,
      pluginFileCount: built.pluginFileCount,
      pathEscapeRejected: true,
      unexpectedTreeContentRejected: true,
      invalidDefaultPromptsRejected: true,
      legacyPromptOwnershipMigrationVerified: true,
      legacyPromptMigrationRequiresExpectedIdentity: true,
      excludedDevelopmentTrees: true,
      credentialInputsAccepted: false,
      sourceAllowlistOnly: true,
      authorityEffect: "none",
      mitLicensePackaged: true,
      exactSkillFilesVerified: skillFiles,
      conversationSkillVerified: { path: conversationSkill, sha256: conversationEntry.sha256, bytes: conversationBytes.length },
    }, null, 2)}\n`);
  } finally {
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    const resolvedOsTemp = path.resolve(os.tmpdir());
    if (path.dirname(resolvedTemporaryRoot) === resolvedOsTemp
      && path.basename(resolvedTemporaryRoot).startsWith("lode-agent-codex-marketplace-")) {
      fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
    }
  }
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  BUILD_RECIPE,
  decideMarketplacePublication,
  decideReleasePublication,
  logicalPublicationDigest,
  publicationGithub,
  readPublicationSnapshot,
} from "./lib/distribution/publication-version.mjs";

const options = Object.create(null);
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (
    !["--provider", "--root", "--previous-root", "--previous-commit", "--repository", "--marketplace-name", "--source-commit", "--source-root"].includes(key) ||
    options[key] ||
    !process.argv[i + 1] ||
    process.argv[i + 1].startsWith("--")
  )
    throw new Error("Invalid publication verifier arguments.");
  options[key] = process.argv[i + 1];
}
const sourceRoot = path.resolve(options["--source-root"] || ".");
const sourceCommit = options["--source-commit"];
if (!/^[a-f0-9]{40}$/.test(sourceCommit || "")) throw new Error("Exact source commit is required.");
const api = publicationGithub({ repository: options["--repository"], token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "" });
let result;
if (options["--provider"] === "release") {
  const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(sourceRoot, ".codex-plugin/plugin.json"), "utf8"));
  if (pkg.version !== plugin.version) throw new Error("Package/plugin version mismatch.");
  result = decideReleasePublication({ version: pkg.version, sourceCommit, tagCommit: await api.tag(pkg.version), release: await api.release(pkg.version) });
} else {
  const args = { provider: options["--provider"], repository: options["--repository"], marketplaceName: options["--marketplace-name"] };
  const candidate = readPublicationSnapshot({ ...args, root: options["--root"], requireNativeBundle: true });
  if (candidate.sourceCommit !== sourceCommit) throw new Error("Snapshot source does not match build.");
  let previous = null;
  if (options["--previous-root"]) {
    try {
      previous = readPublicationSnapshot({ ...args, root: options["--previous-root"] });
    } catch (error) {
      // Historical exceptions stay outside distributed runtime modules. Candidates never use them.
      const { readPreviousPublication } = await import("../legacy/marketplace-ownership/publication.mjs");
      previous = readPreviousPublication({ ...args, root: options["--previous-root"], snapshotCommit: options["--previous-commit"] });
    }
  }
  // Higher versions need integrity/ownership proof, not unavailable historical build recipes.
  if (previous?.pluginVersion === candidate.pluginVersion) {
    candidate.logicalDigest = logicalPublicationDigest({ ...candidate, recipe: fs.readFileSync(path.join(sourceRoot, BUILD_RECIPE)) });
    previous.logicalDigest = logicalPublicationDigest({ ...previous, recipe: await api.recipe(previous.sourceCommit) });
  }
  result = decideMarketplacePublication({ candidate, previous, tagCommit: await api.tag(candidate.pluginVersion) });
}
process.stdout.write(`${JSON.stringify(result)}\n`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `action=${result.action}\n`);

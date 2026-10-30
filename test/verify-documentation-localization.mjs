import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const docsDir = path.join(root, "docs");
const koDir = path.join(docsDir, "ko");

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

function fencedBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split(/\r?\n/);
  let fence = null;
  let body = [];
  for (const line of lines) {
    const match = line.match(/^\s*(```+|~~~+)/);
    if (!fence && match) {
      fence = match[1][0];
      body = [line];
    } else if (fence) {
      body.push(line);
      if (match && match[1][0] === fence) {
        blocks.push(body.join("\n"));
        fence = null;
        body = [];
      }
    }
  }
  assert.equal(fence, null, "unclosed Markdown fence");
  return blocks;
}

function inlineCode(markdown) {
  const outsideFences = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```+|~~~+)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) outsideFences.push(line);
  }
  const tokens = [];
  for (const match of outsideFences.join("\n").matchAll(/(`+)([^`\n]+)\1/g)) {
    tokens.push(match[0]);
  }
  return tokens;
}

function links(markdown) {
  const results = [];
  const expression = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(expression)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    target = target.split(/\s+["']/)[0];
    results.push(target);
  }
  return results;
}

function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target);
}

function withoutFragment(target) {
  return decodeURIComponent(target.split("#", 1)[0].split("?", 1)[0]);
}

function assertLinksExist(filePath, markdown) {
  for (const target of links(markdown)) {
    if (isExternal(target) || !withoutFragment(target)) continue;
    const resolved = path.resolve(path.dirname(filePath), withoutFragment(target));
    assert.ok(fs.existsSync(resolved), `${path.relative(root, filePath)} has broken link: ${target}`);
  }
}

function htmlImages(markdown) {
  return [...markdown.matchAll(/<img\b([^>]+)>/gi)].map(([, body]) => {
    const attributes = {};
    for (const [, name, , value] of body.matchAll(/([a-z][\w-]*)\s*=\s*(["'])(.*?)\2/gi)) {
      const key = name.toLowerCase();
      assert(!Object.hasOwn(attributes, key), `Duplicate image attribute: ${key}`);
      attributes[key] = value;
    }
    return attributes;
  });
}

function assertHtmlImages(filePath, markdown) {
  const images = htmlImages(markdown);
  for (const image of images) {
    assert(typeof image.src === "string" && image.src.length > 0, "HTML image requires a relative src");
    const source = decodeURIComponent(image.src);
    assert(!/^[a-z][a-z0-9+.-]*:|^[\\/]|[\\?#]/i.test(source), "HTML image src must be a local relative path");
    const target = path.resolve(path.dirname(filePath), source), relative = path.relative(root, target);
    assert(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "HTML image escapes documentation root");
    assert(fs.statSync(target, { throwIfNoEntry: false })?.isFile(), `Missing HTML image: ${image.src}`);
    assert(image.alt?.trim(), "HTML image requires readable alt text");
    assert(/^[1-9][0-9]*$/.test(image.width || ""), "HTML image requires a positive proportional width");
  }
  return images;
}

function expectedKoreanTarget(sourcePath, target) {
  if (isExternal(target) || !withoutFragment(target)) return target;
  const suffix = target.slice(withoutFragment(target).length);
  const sourceResolved = path.resolve(path.dirname(sourcePath), withoutFragment(target));
  if (sourceResolved === path.join(root, "README.md")) {
    return path.join(root, "README.ko.md") + suffix;
  }
  const relativeToDocs = path.relative(docsDir, sourceResolved);
  const staysInDocs = relativeToDocs !== ".." && !relativeToDocs.startsWith(`..${path.sep}`);
  if (staysInDocs && fs.existsSync(path.join(koDir, relativeToDocs))) {
    return path.join(koDir, relativeToDocs) + suffix;
  }
  return sourceResolved + suffix;
}

const publicIndex = fs.readFileSync(path.join(docsDir, "README.md"), "utf8");
const indexedEnglishFiles = links(publicIndex)
  .map(withoutFragment)
  .filter((target) => /^[^/\\]+\.md$/i.test(target));
const englishFiles = [...new Set(["README.md", ...indexedEnglishFiles])].sort();
for (const name of englishFiles) {
  assert.ok(fs.existsSync(path.join(docsDir, name)), `public documentation index points to missing file: ${name}`);
}
const koreanFiles = markdownFiles(koDir);
assert.deepEqual(koreanFiles, englishFiles, "docs/ko must contain one exact-basename counterpart for every public docs/*.md file");

for (const name of englishFiles) {
  const sourcePath = path.join(docsDir, name);
  const koreanPath = path.join(koDir, name);
  const source = fs.readFileSync(sourcePath, "utf8");
  const korean = fs.readFileSync(koreanPath, "utf8");
  const koreanComparable = korean.replace(/^>.*\(\.\.\/[^)]+\).*\r?\n(?:\r?\n)?/m, "");

  assertLinksExist(sourcePath, source);
  assertLinksExist(koreanPath, korean);
  assert.match(korean, new RegExp(`\\(\\.\\./${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`), `${name} must link to its English source`);

  const sourceFences = fencedBlocks(source);
  const koreanFences = fencedBlocks(korean);
  assert.deepEqual(koreanFences, sourceFences, `${name} must preserve fenced code blocks byte-for-byte apart from line endings`);
  assert.deepEqual(inlineCode(koreanComparable).sort(), inlineCode(source).sort(), `${name} must preserve the inline code token multiset`);

  if (name !== "Lode_GraphDB_Brief_v4.md") {
    const prose = korean.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
    assert.ok((prose.match(/[가-힣]/g) ?? []).length >= 40, `${name} does not contain enough Korean prose`);
  }

  const sourceTargets = links(source).filter((target, index) => !(name === "README.md" && index === 0 && target === "ko/README.md"));
  const koreanTargets = links(korean).filter((target, index) => !(index === 0 && target === `../${name}`));
  assert.equal(koreanTargets.length, sourceTargets.length, `${name} must preserve the source link set`);
  for (let index = 0; index < sourceTargets.length; index += 1) {
    const expected = expectedKoreanTarget(sourcePath, sourceTargets[index]);
    const actualTarget = koreanTargets[index];
    if (isExternal(sourceTargets[index])) {
      assert.equal(actualTarget, expected, `${name} changed external link ${sourceTargets[index]}`);
    } else {
      const actual = path.resolve(path.dirname(koreanPath), withoutFragment(actualTarget));
      assert.equal(actual, withoutFragment(expected), `${name} changed the destination of ${sourceTargets[index]}`);
    }
  }
}

const publicMarkdown = [
  fs.readFileSync(path.join(root, "README.md"), "utf8"),
  fs.readFileSync(path.join(root, "README.ko.md"), "utf8"),
  ...englishFiles.map((name) => fs.readFileSync(path.join(docsDir, name), "utf8")),
  ...koreanFiles.map((name) => fs.readFileSync(path.join(koDir, name), "utf8")),
].join("\n");
assert.doesNotMatch(publicMarkdown, /neo\s*pick/i, "public documentation must not contain NeoPick material");
assert.doesNotMatch(publicMarkdown, /status-alpha|\bUNLICENSED\b/i, "public documentation must not retain the superseded alpha or unlicensed status");

for (const readmeName of ["README.md", "README.ko.md"]) {
  const readme = fs.readFileSync(path.join(root, readmeName), "utf8");
  assert.match(readme, /docs\/README\.md/, `${readmeName} must link the English documentation index`);
  assert.match(readme, /docs\/ko\/README\.md/, `${readmeName} must link the Korean documentation index`);
  assertLinksExist(path.join(root, readmeName), readme);
  const images = assertHtmlImages(path.join(root, readmeName), readme);
  const iconSource = "docs/assets/branding/lode-repository-icon.png";
  assert.deepEqual(images[0], { src: "docs/assets/branding/lode-readme-wordmark.png", alt: "Lode Agent Core", width: "720" }, `${readmeName} must restore the accepted large wordmark at the top`);
  assert.equal(images.filter((image) => image.src === iconSource).length, 0, `${readmeName} no longer substitutes the small repository icon for its wordmark`);
  assert(readme.indexOf("lode-readme-wordmark.png") < readme.indexOf("# Lode"), `${readmeName} wordmark must be visible outside the background details`);
  const wordmarks = images.filter((image) => image.src === "docs/assets/branding/lode-readme-wordmark.png");
  assert.equal(wordmarks.length, 1, `${readmeName} must retain exactly one accepted wordmark`);
  assert.deepEqual(wordmarks[0], { src: "docs/assets/branding/lode-readme-wordmark.png", alt: "Lode Agent Core", width: "720" }, `${readmeName} must retain the accepted wordmark attributes independently of image order`);
}

for (const [relative, expected] of [
  ["docs/assets/branding/lode-readme-wordmark.png", "23045a8fdb4cde11f0ca0f5cdea4feb19c0057b4a6c60d126f5f133d4d5ee78a"],
  ["docs/assets/branding/lode-repository-icon.png", "742b3cca51efa3b0d1d16dd647fbc050de115df84caac6beb1357171630baffa"],
]) assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex"), expected, `Approved image pixels/bytes changed: ${relative}`);

const imageFixtureBase = path.join(root, "README.md");
assert.throws(() => assertHtmlImages(imageFixtureBase, '<img src="docs/assets/branding/missing.png" alt="Missing" width="720">'), /Missing HTML image/);
assert.throws(() => assertHtmlImages(imageFixtureBase, '<img src="../outside.png" alt="Escape" width="720">'), /escapes documentation root/);
assert.throws(() => assertHtmlImages(imageFixtureBase, '<img src="https://example.invalid/image.png" alt="External" width="720">'), /local relative path/);
assert.throws(() => htmlImages('<img src="one.png" src="two.png">'), /Duplicate image attribute/);

const koreanReadme = fs.readFileSync(path.join(root, "README.ko.md"), "utf8");
const englishReadme = fs.readFileSync(path.join(root, "README.md"), "utf8");
for (const [name, readme] of [["README.md", englishReadme], ["README.ko.md", koreanReadme]]) {
  assert.match(readme, /status-beta-blue/, `${name} must publish the beta status badge`);
  assert.match(readme, /\[MIT License\]\(LICENSE\)/, `${name} must link the canonical MIT license`);
  assert.match(readme, /git clone https:\/\/github\.com\/binary1215\/lode\.git lode\r?\n/, `${name} must clone into the documented lode directory`);
  assert.match(readme, /Set-Location \.\\lode\r?\n/, `${name} PowerShell directory must match the clone target`);
  assert.match(readme, /cd lode\r?\n/, `${name} shell directory must match the clone target`);
  assert.match(readme, /lode-agent --version/, `${name} must preserve the actual installed executable`);
  const normalizedReadme = readme.replace(/\r\n/g, "\n");
  const noticeStart = normalizedReadme.indexOf(name === "README.md" ? "## Install\n" : "## 설치\n");
  const firstInstallCommand = normalizedReadme.indexOf("codex plugin marketplace add", noticeStart);
  assert.ok(noticeStart >= 0 && firstInstallCommand > noticeStart, `${name} must retain an installation section`);
  const installNotice = normalizedReadme.slice(noticeStart, firstInstallCommand);
  for (const token of ["`lode`", "`mcp__head_core__...`", "`mcp__lode_core__...`", "`head_*`"])
    assert.ok(installNotice.includes(token), `${name} must disclose the Host namespace migration boundary near installation: ${token}`);
  assert.doesNotMatch(normalizedReadme.slice(0, noticeStart), /\]\(docs\/(?:ko\/)?recovery-state-separation\.md\)/, `${name} recovery reference belongs in documentation navigation, not the opening banner`);
  assert.match(normalizedReadme.slice(noticeStart), /\]\(docs\/(?:ko\/)?recovery-state-separation\.md\)/, `${name} must retain access to recovery guidance`);
}

for (const languageDir of [docsDir, koDir]) {
  for (const file of ["codex-marketplace.md", "claude-marketplace.md"]) {
    const guide = fs.readFileSync(path.join(languageDir, file), "utf8");
    const notice = guide.slice(guide.indexOf("plugin marketplace add"), guide.indexOf("## Upgrade") > 0 ? guide.indexOf("## Upgrade") : guide.indexOf("## 업그레이드"));
    for (const token of ["`lode`", "`mcp__head_core__...`", "`mcp__lode_core__...`", "`head_*`"])
      assert.ok(notice.includes(token), `${file} must keep the Host migration notice next to installation: ${token}`);
  }
  const history = fs.readFileSync(path.join(languageDir, "original-head-core-comparison.md"), "utf8");
  assert.match(history, /2026-08-20/, "Keep the historical comparison date");
  assert.match(history, /2026-10-20/, "Label the separate source-path verification date");
  for (const commit of ["ba220c55c14b8af947bf6d1fb9d27a620a2cf2aa", "067701f0c0390a6b9f7dfd1a90a417d10247bd02"])
    assert.ok(history.includes(`https://github.com/Won6314/head-agent-core/tree/${commit}`), "Current verification references must be immutable upstream commit links");
  const sourceCollection = fs.readFileSync(path.join(languageDir, "observation-adapters.md"), "utf8");
  for (const token of ["`LODE_PYTHON`", "`HEAD_PYTHON`"])
    assert.ok(sourceCollection.includes(token), "Python interpreter guidance must retain both canonical and compatibility settings");
  const onboarding = fs.readFileSync(path.join(languageDir, "onboarding.md"), "utf8");
  assert.match(onboarding, /"username": "LODE_GRAPHDB_USERNAME"/, "New GraphDB examples use caller-selected Lode reference names");
  assert.match(onboarding, /"password": "LODE_GRAPHDB_PASSWORD"/, "New GraphDB examples use caller-selected Lode reference names");
  for (const token of ["`HEAD_GRAPHDB_USERNAME`", "`HEAD_GRAPHDB_PASSWORD`"])
    assert.ok(onboarding.includes(token), "Existing saved secret-reference names must remain documented");
}
assert.deepEqual(
  links(koreanReadme).filter((target) => /^https?:/i.test(target)).sort(),
  links(englishReadme).filter((target) => /^https?:/i.test(target)).sort(),
  "README language variants must preserve the same external link set",
);
for (const target of links(koreanReadme).filter((entry) => entry.startsWith("docs/"))) {
  assert.ok(target === "docs/README.md" || target.startsWith("docs/ko/"), `README.ko.md routes a detailed document link to English: ${target}`);
}

const contextCompiler = fs.readFileSync(path.join(docsDir, "context-compiler.md"), "utf8");
assert.match(contextCompiler, /any positive safe integer/i, "Context docs must describe arbitrary positive safe budgets");
assert.match(contextCompiler, /No coverage-proof state machine/i, "Context docs must disclose advisory selection rather than inclusion-proof gating");
assert.match(fs.readFileSync(path.join(docsDir, "product-operating-loop.md"), "utf8"), /protocol `0\.4\.0`/i);
assert.match(fs.readFileSync(path.join(docsDir, "onboarding.md"), "utf8"), /Claude Code, Codex, OpenCode/);

console.log(JSON.stringify({
  status: "ok",
  englishDocuments: englishFiles.length,
  koreanDocuments: koreanFiles.length,
  publicIndex: "docs/README.md",
}));

#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lode-agent-newcomer-"));
const projectRoot = path.join(scratchRoot, "sample-project");
const installRoot = path.join(scratchRoot, "user-data", "lode-agent-core");
const binDirectory = path.join(scratchRoot, "user-home", ".local", "bin");
const proposalFile = path.join(scratchRoot, "onboarding-proposal.json");
const reviewFile = path.join(scratchRoot, "onboarding-review.json");
const maximumOutputBytes = 8 * 1024 * 1024;

function recordProcess(event) {
  if (event.type === "spawn") {
    process.stderr.write(`NESTED_CHILD_START pid=${event.pid} parent=${process.pid} command=${event.command} cwd=${event.cwd} ports=none\n`);
  } else {
    process.stderr.write(`NESTED_CHILD_END pid=${event.pid} parent=${process.pid} exit=${event.exitCode ?? "null"} signal=${event.signal || "none"}\n`);
  }
}

function spawnCaptured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    recordProcess({ type: "spawn", pid: child.pid, command: `${path.basename(command)} ${args.join(" ")}`, cwd: options.cwd || process.cwd() });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumOutputBytes) outputExceeded = true;
      else stdout.push(chunk);
      if (outputExceeded) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maximumOutputBytes) outputExceeded = true;
      else stderr.push(chunk);
      if (outputExceeded) child.kill();
    });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      recordProcess({ type: "exit", pid: child.pid, exitCode, signal });
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        outputExceeded,
      });
    });
  });
}

function parseResult(result, expectedExitCode = 0) {
  assert.equal(result.outputExceeded, false, "Newcomer command exceeded its fixed output budget.");
  assert.equal(result.exitCode, expectedExitCode, result.stderr || result.stdout);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Newcomer command did not return JSON: ${error.message}\n${result.stdout.slice(0, 1000)}`);
  }
}

async function runNode(args, expectedExitCode = 0) {
  return parseResult(await spawnCaptured(process.execPath, args, { cwd: sourceRoot }), expectedExitCode);
}

function commandArgument(value) {
  if (value.includes('"') || value.includes("\r") || value.includes("\n")) throw new Error("Unsafe Windows command fixture argument.");
  return `"${value}"`;
}

async function runGlobal(args, expectedExitCode = 0) {
  const machineArgs = args.includes("--json") ? args : [...args, "--json"];
  if (process.platform !== "win32") {
    return parseResult(await spawnCaptured(path.join(binDirectory, "lode-agent"), machineArgs, { cwd: scratchRoot }), expectedExitCode);
  }
  const command = path.join(binDirectory, "lode-agent.cmd");
  const commandLine = `""${command}" ${machineArgs.map(commandArgument).join(" ")}"`;
  return parseResult(
    await spawnCaptured(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
      cwd: scratchRoot,
      windowsVerbatimArguments: true,
    }),
    expectedExitCode,
  );
}

function headingSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

// Structural README checks only: every local link resolves to a real file, every
// fragment resolves to an explicit anchor or heading in its target, and the
// English and Korean READMEs carry the same fragment links in the same order.
function readmeFragmentLinks(name) {
  const file = path.join(sourceRoot, name);
  const readme = fs.readFileSync(file, "utf8");
  const fragments = [];
  for (const [, rawTarget] of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(rawTarget)) continue;
    const [targetPath, fragment] = rawTarget.split("#", 2);
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(targetPath));
    assert(fs.existsSync(resolved), `${name} has a broken link: ${rawTarget}`);
    if (!fragment) continue;
    const content = fs.readFileSync(resolved, "utf8");
    const anchors = new Set([
      ...[...content.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
      ...[...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => headingSlug(match[1])),
    ]);
    assert(anchors.has(fragment), `${name} links a missing anchor: ${rawTarget}`);
    fragments.push(fragment);
  }
  return fragments;
}

function assertReadmeLinks() {
  assert.deepEqual(
    readmeFragmentLinks("README.ko.md"),
    readmeFragmentLinks("README.md"),
    "README language variants must link the same anchors in the same order",
  );
}

try {
  assertReadmeLinks();
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "README.md"), "# Request workspace\n\nAccept and validate a request before publishing its receipt.\n", "utf8");
  fs.writeFileSync(
    path.join(projectRoot, "src", "request-service.mjs"),
    [
      "export function acceptRequest(queue) { return queue.take(); }",
      "export function validateRequest(fields) { return { fieldCount: fields.length, valid: fields.length > 2 }; }",
      "export function publishReceipt(request) { return { accepted: request.valid === true }; }",
      "",
    ].join("\n"),
    "utf8",
  );

  const installed = await runNode([
    path.join(sourceRoot, "scripts", "distribution.mjs"),
    "install",
    "--source",
    sourceRoot,
    "--install-root",
    installRoot,
    "--bin-dir",
    binDirectory,
    "--native",
    "off",
    "--project",
    projectRoot,
    "--runtime",
    "claude,codex,opencode",
    "--profile",
    "product",
  ]);
  assert.equal(installed.status, "installed");
  assert.equal(installed.native.status, "javascript-fallback");
  assert.equal(installed.native.deliveryStatus, "disabled");
  assert.equal(installed.project.onboardingAction, "started");
  assert.equal(installed.project.status, "product_evidence_required");
  assert.equal(installed.project.onboarding.candidateCount, 0);
  assert.equal(installed.project.onboarding.storageMode, "local");
  assert.equal(fs.existsSync(path.join(projectRoot, ".git")), false);

  const version = await runGlobal(["--version"]);
  assert.equal(version.version, installed.version);
  const doctor = await runGlobal(["doctor", projectRoot]);
  assert.equal(doctor.project.projectRoot, fs.realpathSync(projectRoot));
  const evidenceRequired = await runGlobal(["onboarding-status", projectRoot]);
  assert.equal(evidenceRequired.status, "awaiting_evidence");
  fs.writeFileSync(
    proposalFile,
    `${JSON.stringify(
      {
        mode: "existing",
        semanticProposal: {
          schemaVersion: 1,
          sourceSnapshotId: evidenceRequired.state.sourceSnapshotId,
          candidates: [
            {
              productKind: "Capability",
              proposedEntity: { key: "capability:requests", name: "Request processing", description: "Accept current user requests." },
              evidence: [{ path: "src/request-service.mjs", line: 1 }],
              explanation: "Fresh Lode semantic proposal for the newcomer flow.",
              confidence: 0.8,
            },
            {
              productKind: "Feature",
              proposedEntity: {
                key: "feature:accept-request",
                name: "Accept a request",
                description: "Accept one current user request.",
                featureGroupKeys: [],
                capabilityKeys: ["capability:requests"],
                governedBy: [],
              },
              evidence: [{ path: "src/request-service.mjs", line: 1 }],
              explanation: "Fresh Lode semantic proposal for the newcomer flow.",
              confidence: 0.8,
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const proposed = await runGlobal(["onboarding-start", projectRoot, "--input", proposalFile]);
  assert.equal(proposed.status, "awaiting_onboarding_review");
  const pending = await runGlobal(["onboarding-status", projectRoot]);
  assert.equal(pending.status, "awaiting_review");
  assert.match(pending.state.candidateSetId, /^onboarding-candidates-[a-f0-9]{24}$/u);
  const worldBeforeReview = await runGlobal(["world-status", projectRoot]);
  assert.equal(worldBeforeReview.status, "current");
  const candidates = await runGlobal(["onboarding-candidates", projectRoot, "--candidate-set", pending.state.candidateSetId]);
  assert.equal(candidates.candidateSet.candidateSetId, pending.state.candidateSetId);
  assert.equal(candidates.candidateSet.candidates.length > 0, true);

  fs.writeFileSync(
    reviewFile,
    `${JSON.stringify(
      {
        candidateSetId: pending.state.candidateSetId,
        disposition: "accept-all",
        rationale: "Fixture reviewer inspected every evidence-linked candidate and adopts this bootstrap batch.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const reviewed = await runGlobal(["onboarding-review", projectRoot, "--input", reviewFile]);
  assert.equal(reviewed.status, "onboarding_ready");
  assert.equal(reviewed.reviewDecision.promotionAuthority, true);
  assert.equal(reviewed.productModel.features.length > 0, true);

  const ready = await runGlobal(["onboarding-status", projectRoot]);
  assert.equal(ready.status, "ready");
  assert.equal(ready.productModel.productModelId, reviewed.productModel.productModelId);
  const world = await runGlobal(["world-status", projectRoot]);
  assert.equal(world.status, "current");
  assert.equal(world.snapshot.temporalProvenanceGraph.summary.featureCount > 0, true);
  const contextTask = "Find request acceptance and validation evidence";
  const preparation = await runGlobal(["context-prepare", projectRoot, "--task", contextTask, "--budget", "32768"]);
  assert.equal(preparation.status, "prepared");
  assert.equal(preparation.preparation.status, "ready_for_lode_semantic_assessment");
  assert.equal(preparation.preparation.task, contextTask);
  assert(preparation.preparation.selectedContext.repositoryFiles.length > 0);
  assert.equal(preparation.preparation.authority.selectsEvidenceNeeds, false);
  const context = await runGlobal(["context-preview", projectRoot, "--task", contextTask, "--budget", "32768"]);
  assert.equal(context.status, "preview");
  assert.equal("file" in context, false);
  assert.equal(context.capsule.productContext.length > 0, true);
  assert.equal(context.workflow.budget.requestedApproxTokens, 32768);
  assert.equal(context.workflow.budget.providerFitVerified, false);
  assert.equal("attemptedTiers" in context.workflow.budget, false);
  assert.equal("coverageAssessment" in context.capsule, false);
  assert.equal(context.workflow.capsule.persisted, false);
  const documents = await runGlobal(["world-docs-build", projectRoot]);
  assert.equal(documents.status, "projected");

  const resumed = await runGlobal(["resume", projectRoot, "--runtime", "claude,codex,opencode", "--profile", "product"]);
  assert.equal(resumed.status, "product_ready");
  assert.equal(resumed.readiness.product.state, "ready");
  assert.equal(resumed.project.projectId, installed.project.project.projectId);
  assert.equal(resumed.project.sessionId, installed.project.project.sessionId);
  const distributionStatus = await runNode([
    path.join(sourceRoot, "scripts", "distribution.mjs"),
    "status",
    "--install-root",
    installRoot,
    "--bin-dir",
    binDirectory,
  ]);
  assert.equal(distributionStatus.status, "ready");

  const uninstalled = await runNode([
    path.join(sourceRoot, "scripts", "distribution.mjs"),
    "uninstall",
    "--install-root",
    installRoot,
    "--bin-dir",
    binDirectory,
    "--purge",
  ]);
  assert.equal(uninstalled.status, "uninstalled");
  assert.equal(uninstalled.projectStatePreserved, true);
  assert.equal(fs.existsSync(path.join(projectRoot, ".lode", "project.json")), true);
  assert.equal(fs.existsSync(installRoot), false);

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        platform: process.platform,
        sourceControlRequired: false,
        graphDbRequired: false,
        nativeBinaryRequired: false,
        explicitReviewPromotedCanon: true,
        graphContextAndDocumentsVerified: true,
        resumePreservedProjectAndSession: true,
        uninstallPreservedProjectState: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

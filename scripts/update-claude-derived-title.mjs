import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { observeClaudeTitleFile, checkClaudeTitlePlan, checkClaudeTitleBasis, checkClaudeTitleAppend } from "./lib/claude-derived-title.mjs";
import { derivedHash as hash } from "./lib/claude-derived-encoder.mjs";
import { nativeRoot } from "./lib/provider-native-history-host.mjs";

const [entry, cwd, planFile, planSha256] = process.argv.slice(2);
const raw = fs.readFileSync(planFile);
if (hash(raw) !== planSha256) throw Error("TITLE_PLAN_CHANGED");
const plan = JSON.parse(raw); checkClaudeTitlePlan(plan);
if (nativeRoot(cwd) !== nativeRoot(plan.projectRoot) || nativeRoot(process.env.CLAUDE_CONFIG_DIR) !== nativeRoot(plan.nativeHome)) throw Error("TITLE_HOST_TARGET_CHANGED");
const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "package.json")));
if (pkg.name !== "@anthropic-ai/claude-agent-sdk" || pkg.version !== "0.3.234") throw Error("TITLE_SDK_UNQUALIFIED");
const sdk = await import(pathToFileURL(entry).href);
if (typeof sdk.renameSession !== "function" || typeof sdk.getSessionInfo !== "function") throw Error("TITLE_SDK_API_UNAVAILABLE");
const info = await sdk.getSessionInfo(plan.nativeId, { dir: cwd });
if (info?.sessionId !== plan.nativeId || nativeRoot(info.cwd) !== nativeRoot(cwd)) throw Error("TITLE_SDK_TARGET_CHANGED");
const before = observeClaudeTitleFile(plan.nativeHome, plan.relativeFile); checkClaudeTitleBasis(plan, before);
if (hash(JSON.stringify(info.customTitle ?? null, null, 2) + "\n") !== plan.expectedTitleSha256) throw Error("TITLE_SDK_BASELINE_CHANGED");
await sdk.renameSession(plan.nativeId, plan.desiredTitle, { dir: cwd });
const after = observeClaudeTitleFile(plan.nativeHome, plan.relativeFile); checkClaudeTitleBasis(plan, after, { checkTitle: false });
checkClaudeTitleAppend(plan, before, after);
const afterInfo = await sdk.getSessionInfo(plan.nativeId, { dir: cwd });
if (!after.raw.subarray(0, before.raw.length).equals(before.raw) || after.title !== plan.desiredTitle
  || afterInfo?.sessionId !== plan.nativeId || afterInfo.customTitle !== plan.desiredTitle) throw Error("TITLE_SDK_POSTCONDITION_UNCERTAIN");
process.stdout.write(JSON.stringify({ sdkVersion: "0.3.234", nativeId: plan.nativeId, sdkTitleMatches: true,
  appendOnlyVerified: true, messageDigest: after.messageDigest, modelCalled: false }) + "\n");

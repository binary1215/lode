// Model-free stand-in for `claude --print` in the Claude fresh-proposal recipe.
// It checks what crossed the process boundary (arguments, environment, input),
// then writes stream-json records shaped like the installed Claude Code's.
// The only switch is a fixed file in this fixture's disposable profile home.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const launched = Date.now();
const args = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE || "";
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(path.join(home, "claude-fixture.json"), "utf8"));
} catch {}
const scenario = settings.scenario || "normal";
const sessionId = crypto.randomUUID();
const write = (record) => process.stdout.write(`${JSON.stringify({ ...record, session_id: sessionId })}\n`);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
function wireProblem() {
  const exact = ["--print", "--verbose", "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config"];
  if (exact.some((flag) => !args.includes(flag))) return "missing fixed flag";
  if (value("--output-format") !== "stream-json" || value("--permission-mode") !== "dontAsk") return "output or permission mode";
  if (value("--tools") !== "" || value("--setting-sources") !== "") return "tools or setting sources not empty";
  if (value("--mcp-config") !== JSON.stringify({ mcpServers: {} })) return "mcp config not empty";
  if (!/^claude-/.test(value("--model") || "")) return "model";
  if (!(value("--system-prompt") || "").startsWith("You are a bounded patch-proposal worker.")) return "system prompt";
  if (args.includes("--dangerously-skip-permissions") || args.includes("--allowedTools")) return "forbidden flag";
  let schema;
  try {
    schema = JSON.parse(value("--json-schema"));
  } catch {
    return "schema";
  }
  if (!schema?.properties?.patchProposal) return "schema without patchProposal";
  const names = Object.keys(process.env).map((name) => name.toUpperCase());
  if (names.includes("PATH") || names.includes("NODE_OPTIONS") || names.includes("ANTHROPIC_API_KEY")) return "environment carries a forbidden variable";
  if (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== "1" || process.env.DISABLE_AUTOUPDATER !== "1") return "environment misses fixed values";
  if (path.basename(process.cwd()) !== "workspace") return "not started in the selected workspace";
  return null;
}
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
  const problem = wireProblem();
  if (problem) {
    write({ type: "result", subtype: "error_during_execution", is_error: true, result: `fixture wire check failed: ${problem}` });
    process.exitCode = 3;
    return;
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const tools = scenario === "extra-tool" ? ["Bash", "StructuredOutput"] : ["StructuredOutput"];
  const plugins = [{ name: "cc-plugin-agents-md", path: "builtin", source: "cc-plugin-agents-md@builtin" }];
  if (scenario === "user-plugin") plugins.push({ name: "userplug", path: process.cwd(), source: "userplug@usermarket", version: "1.0.0" });
  write({ type: "system", subtype: "init", cwd: process.cwd(), tools, mcp_servers: [], model: value("--model"), skills: [], slash_commands: [], plugins });
  if (scenario === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  const started = Date.now();
  if (settings.stayMs) await new Promise((resolve) => setTimeout(resolve, settings.stayMs));
  if (settings.overlapDirectory)
    fs.writeFileSync(
      path.join(settings.overlapDirectory, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, taskKey: input.boundedWorker?.taskKey ?? null, launched, started, ended: Date.now() }),
    );
  if (scenario === "rate-limit") {
    for (const attempt of [1, 2])
      write({ type: "system", subtype: "api_retry", attempt, max_retries: 2, retry_delay_ms: 1, error_status: 429, error: "rate_limit" });
    write({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "API Error: Request rejected (429) · rate_limit_error" }] } });
    write({ type: "result", subtype: "success", is_error: true, result: "API Error: Request rejected (429) · rate_limit_error" });
    process.exitCode = 1;
    return;
  }
  if (scenario === "retry-then-success")
    for (const attempt of [1, 2])
      write({ type: "system", subtype: "api_retry", attempt, max_retries: 4, retry_delay_ms: 1, error_status: 429, error: "rate_limit" });
  if (scenario === "tool-call") {
    const call = { type: "tool_use", id: "toolu_fixture", name: "Bash", input: { command: "echo" } };
    write({ type: "assistant", message: { role: "assistant", content: [call] } });
  }
  const before = input.boundedWorker?.proposalBasis?.[0];
  const proposalBasisDigest = input.boundedWorker?.executionBoundary?.proposalBasisDigest || "0".repeat(64);
  const contents = scenario === "sensitive-result" ? `${process.cwd()}\n` : "synthetic Claude proposed bytes\n";
  const result = {
    schemaVersion: 1,
    kind: "RuntimeStructuredResult",
    protocolVersion: "0.2.0",
    outcome: "Synthetic Claude fresh proposal only",
    evidence: ["Model-free Claude protocol fixture"],
    planDelta: "",
    impactRadius: [],
    verification: ["No task effects performed"],
    unknowns: [],
    patchProposal: {
      proposalBasisDigest,
      changes: before
        ? [
            {
              path: scenario === "outside-basis" ? "src/outside.mjs" : before.path,
              after: { contentBase64: Buffer.from(contents).toString("base64"), mode: before.mode ?? 438 },
            },
          ]
        : [],
    },
  };
  const structured = { type: "tool_use", id: "toolu_structured", name: "StructuredOutput", input: result };
  write({ type: "assistant", message: { role: "assistant", content: [structured] } });
  write({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    total_cost_usd: 0,
    result: JSON.stringify(result),
    ...(scenario === "missing-result" ? {} : { structured_output: result }),
  });
});

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scenario = process.argv[2] || "barrel";
const opened = new Map();
let buffer = Buffer.alloc(0);
let expected = null;
let descendant = null;
let descendantReady = false;
let pendingCancelledPrepareId = null;
let pendingGrandchildPrepare = null;
let configurationChecked = false;
let applyEditChecked = false;
let progressChecked = false;
const messageResponses = new Set();

function encode(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"), payload]);
}

function write(message, mode = "normal") {
  const bytes = encode(message);
  if (mode === "fragmented") {
    const one = Math.max(1, Math.floor(bytes.length / 3));
    process.stdout.write(bytes.subarray(0, one));
    setTimeout(() => process.stdout.write(bytes.subarray(one, one * 2)), 2);
    setTimeout(() => process.stdout.write(bytes.subarray(one * 2)), 4);
  } else process.stdout.write(bytes);
}

function position(text, offset) {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1).replace(/\r$/, "").length };
}

function range(text, start, length) {
  return { start: position(text, start), end: position(text, start + length) };
}

function codeMask(text) {
  const chars = text.split("");
  let mode = "code";
  let quote = null;
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];
    if (mode === "line") {
      if (current === "\n") mode = "code"; else chars[index] = " ";
    } else if (mode === "block") {
      if (current === "*" && next === "/") { chars[index] = chars[index + 1] = " "; index += 1; mode = "code"; }
      else if (current !== "\n" && current !== "\r") chars[index] = " ";
    } else if (mode === "string") {
      if (current === "\\") { chars[index] = " "; if (index + 1 < chars.length) chars[++index] = " "; }
      else if (current === quote) { chars[index] = " "; mode = "code"; }
      else if (current !== "\n" && current !== "\r") chars[index] = " ";
    } else if (current === "/" && next === "/") { chars[index] = chars[index + 1] = " "; index += 1; mode = "line"; }
    else if (current === "/" && next === "*") { chars[index] = chars[index + 1] = " "; index += 1; mode = "block"; }
    else if (current === "\"" || current === "'" || current === "`") { chars[index] = " "; mode = "string"; quote = current; }
  }
  return chars.join("");
}

function commentMask(text) {
  const chars = text.split("");
  let mode = "code";
  let quote = null;
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];
    if (mode === "line") {
      if (current === "\n") mode = "code"; else chars[index] = " ";
    } else if (mode === "block") {
      if (current === "*" && next === "/") { chars[index] = chars[index + 1] = " "; index += 1; mode = "code"; }
      else if (current !== "\n" && current !== "\r") chars[index] = " ";
    } else if (mode === "string") {
      if (current === "\\") index += 1;
      else if (current === quote) { mode = "code"; quote = null; }
    } else if (current === "/" && next === "/") { chars[index] = chars[index + 1] = " "; index += 1; mode = "line"; }
    else if (current === "/" && next === "*") { chars[index] = chars[index + 1] = " "; index += 1; mode = "block"; }
    else if (current === "\"" || current === "'") { mode = "string"; quote = current; }
  }
  return chars.join("");
}

function hasUnsupportedFixtureLexeme(text) {
  if (text.includes("`")) return true;
  let mode = "code";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (mode === "line") {
      if (current === "\n") mode = "code";
    } else if (mode === "block") {
      if (current === "*" && next === "/") { index += 1; mode = "code"; }
    } else if (mode === "string") {
      if (current === "\\") index += 1;
      else if (current === quote) { mode = "code"; quote = null; }
    } else if (current === "/" && next === "/") {
      index += 1;
      mode = "line";
    } else if (current === "/" && next === "*") {
      index += 1;
      mode = "block";
    } else if (current === "/") {
      return true;
    } else if (current === "\"" || current === "'") {
      mode = "string";
      quote = current;
    }
  }
  return mode === "string" || mode === "block";
}

function moduleRoute(callerText, barrelText) {
  if (hasUnsupportedFixtureLexeme(callerText) || hasUnsupportedFixtureLexeme(barrelText)) return null;
  const caller = commentMask(callerText);
  const callerCode = codeMask(callerText);
  const imports = [...caller.matchAll(/^\s*import\s*\{\s*target\s*\}\s*from\s*["']\.\/(target|barrel)["']\s*;/gm)]
    .filter((match) => callerCode.slice(match.index + match[0].indexOf("import"), match.index + match[0].indexOf("import") + 6) === "import");
  if (imports.length !== 1) return null;
  if (imports[0][1] === "target") return "direct";
  const barrel = commentMask(barrelText);
  const barrelCode = codeMask(barrelText);
  const exports = [...barrel.matchAll(/^\s*export\s*\{\s*target\s*\}\s*from\s*["']\.\/target["']\s*;/gm)]
    .filter((match) => barrelCode.slice(match.index + match[0].indexOf("export"), match.index + match[0].indexOf("export") + 6) === "export");
  return exports.length === 1 ? "barrel" : null;
}

function functionIdentity(text, name) {
  if (hasUnsupportedFixtureLexeme(text)) return null;
  const masked = codeMask(text);
  const matches = [...masked.matchAll(new RegExp(`\\bexport\\s+function\\s+${name}\\s*\\(\\s*\\)\\s*\\{`, "g"))];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const selection = masked.indexOf(name, match.index);
  const open = masked.indexOf("{", match.index);
  let depth = 0;
  let close = -1;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    if (masked[index] === "}" && --depth === 0) { close = index; break; }
  }
  if (selection < 0 || close < 0) return null;
  return { name, bodyStart: open + 1, end: close + 1, range: range(text, match.index, close + 1 - match.index), selectionRange: range(text, selection, name.length) };
}

function callRanges(text, identity, name) {
  if (!identity) return [];
  const body = codeMask(text).slice(identity.bodyStart, identity.end - 1);
  const matches = [...body.matchAll(new RegExp(`\\b${name}\\s*\\(\\s*\\)\\s*;`, "g"))];
  const remainder = body.split("");
  for (const match of matches) remainder.fill(" ", match.index, match.index + match[0].length);
  if (remainder.join("").trim() !== "") return [];
  return matches.map((match) => range(text, identity.bodyStart + match.index + match[0].indexOf(name), name.length));
}

function documentBySuffix(suffix) {
  return [...opened.entries()].find(([uri]) => uri.endsWith(`/${suffix}`));
}

function callerItem(suffix = "caller.ts") {
  const [uri, text] = documentBySuffix(suffix) || [];
  if (!uri) return null;
  const identity = functionIdentity(text, "caller");
  return identity ? { name: "caller", kind: 12, uri, range: identity.range, selectionRange: identity.selectionRange } : null;
}

function targetItem() {
  const [uri, text] = documentBySuffix("target.ts") || [];
  if (!uri) return null;
  const identity = functionIdentity(text, "target");
  if (!identity) return null;
  const item = { name: "target", kind: 12, uri, range: identity.range, selectionRange: identity.selectionRange };
  if (scenario === "external-uri") item.uri = "file:///outside/target.ts";
  if (scenario === "invalid-range") item.selectionRange = { start: { line: 999, character: 0 }, end: { line: 999, character: 1 } };
  return item;
}

function verifyServerResponse(message) {
  if (message.id === "server-config") configurationChecked = Array.isArray(message.result) && message.result.length === 2 && message.result.every((item) => item === null);
  if (message.id === "server-edit") applyEditChecked = message.result?.applied === false && message.result?.failureReason === "Lode LSP Host profile is read-only";
  if (message.id === "server-progress") progressChecked = message.result === null;
  if (["server-message-no-actions", "server-message-empty-actions", "server-message-action"].includes(message.id) && message.result === null) messageResponses.add(message.id);
}

function writeCancelledPrepareTrace() {
  if (!pendingCancelledPrepareId || scenario !== "grandchild-cancel" || !descendantReady) return;
  try { process.getBuiltinModule("fs").appendFileSync(`${fileURLToPath(import.meta.url)}.trace`, `${pendingCancelledPrepareId}:${descendant.pid}:ready\n`); } catch {}
  pendingCancelledPrepareId = null;
}

function startDescendant() {
  const childFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "lsp-host-child.mjs");
  descendant = spawn(process.execPath, [childFile], { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  descendant.once("message", (message) => {
    if (message?.type !== "ready" || message.pid !== descendant.pid) return;
    descendantReady = true;
    write({ jsonrpc: "2.0", method: "telemetry/event", params: { headTestDescendantPid: descendant.pid, headTestDescendantReady: true } });
    writeCancelledPrepareTrace();
    if (scenario === "grandchild-flood") for (let index = 0; index < 129; index += 1) write({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: String(index) } });
    if (pendingGrandchildPrepare) {
      const pending = pendingGrandchildPrepare;
      pendingGrandchildPrepare = null;
      respond(pending);
    }
    descendant.unref();
  });
}

function respond(message) {
  if (scenario === "slow-work" && ["initialize", "textDocument/prepareCallHierarchy", "callHierarchy/outgoingCalls"].includes(message.method) && !message.headDelayed) {
    setTimeout(() => respond({ ...message, headDelayed: true }), 4_600);
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    verifyServerResponse(message);
    return;
  }
  if (message.method === "initialize") {
    if (scenario === "bad-header") { process.stdout.write("Content-Length nope\r\n\r\n{}"); return; }
    if (scenario === "invalid-json") { process.stdout.write("Content-Length: 1\r\n\r\n{"); return; }
    if (scenario === "unknown-id") { write({ jsonrpc: "2.0", id: 999, result: {} }); return; }
    if (scenario === "frame-oversize") { process.stdout.write("Content-Length: 524289\r\n\r\n"); return; }
    write({ jsonrpc: "2.0", id: message.id, result: { capabilities: { callHierarchyProvider: true } } }, scenario === "fragmented" ? "fragmented" : "normal");
    return;
  }
  if (message.method === "initialized") {
    if (["notifications", "reordered", "server-requests"].includes(scenario)) {
      write({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "bounded fixture log" } });
      write({ jsonrpc: "2.0", method: "_typescript.version", params: { version: "fixture" } });
      write({ jsonrpc: "2.0", method: "$/progress", params: { token: "fixture", value: { kind: "report" } } });
    }
    if (scenario === "notification-flood") for (let index = 0; index < 129; index += 1) write({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: String(index) } });
    if (scenario === "unknown-notification") write({ jsonrpc: "2.0", method: "head/unknown", params: {} });
    if (scenario === "unknown-server-request") write({ jsonrpc: "2.0", id: "server-unknown", method: "workspace/executeCommand", params: {} });
    if (scenario === "server-requests") {
      write({ jsonrpc: "2.0", id: "server-config", method: "workspace/configuration", params: { items: [{ section: "a" }, { section: "b" }] } });
      write({ jsonrpc: "2.0", id: "server-edit", method: "workspace/applyEdit", params: { edit: { changes: { "file:///must-not-be-read": [] } } } });
      write({ jsonrpc: "2.0", id: "server-progress", method: "window/workDoneProgress/create", params: { token: "fixture" } });
      write({ jsonrpc: "2.0", id: "server-message-no-actions", method: "window/showMessageRequest", params: { type: 3, message: "fixture" } });
      write({ jsonrpc: "2.0", id: "server-message-empty-actions", method: "window/showMessageRequest", params: { type: 3, message: "fixture", actions: [] } });
      write({ jsonrpc: "2.0", id: "server-message-action", method: "window/showMessageRequest", params: { type: 3, message: "fixture", actions: [{ title: "Continue" }] } });
    }
    if (scenario === "invalid-show-message") write({ jsonrpc: "2.0", id: "server-message-invalid", method: "window/showMessageRequest", params: { type: 5, message: "fixture" } });
    if (["grandchild", "grandchild-flood", "grandchild-cancel"].includes(scenario)) startDescendant();
    return;
  }
  if (message.method === "textDocument/didOpen") {
    opened.set(message.params.textDocument.uri, message.params.textDocument.text);
    return;
  }
  if (message.method === "textDocument/prepareCallHierarchy") {
    if (scenario === "crash") process.exit(31);
    if (["grandchild", "grandchild-flood"].includes(scenario) && !descendantReady) { pendingGrandchildPrepare = message; return; }
    if (scenario === "external-abort") {
      try { process.getBuiltinModule("fs").appendFileSync(`${fileURLToPath(import.meta.url)}.trace`, `${message.id}:ready\n`); } catch {}
      return;
    }
    if (scenario === "grandchild-cancel") {
      pendingCancelledPrepareId = message.id;
      writeCancelledPrepareTrace();
      return;
    }
    if (["timeout", "cancel"].includes(scenario)) return;
    if (scenario === "stderr-limit") { process.stderr.write("x".repeat(1024 * 1024 + 1)); return; }
    if (scenario === "prepare-null") { write({ jsonrpc: "2.0", id: message.id, result: null }); return; }
    if (scenario === "prepare-empty") { write({ jsonrpc: "2.0", id: message.id, result: [] }); return; }
    const item = callerItem();
    if (!item) { write({ jsonrpc: "2.0", id: message.id, result: [] }); return; }
    const [, callerText] = documentBySuffix("caller.ts") || [];
    const expectedPosition = item.selectionRange.start;
    if (message.params?.textDocument?.uri !== item.uri || JSON.stringify(message.params?.position) !== JSON.stringify(expectedPosition)) { write({ jsonrpc: "2.0", id: message.id, result: [] }); return; }
    if (scenario === "ambiguous") { write({ jsonrpc: "2.0", id: message.id, result: [item, { ...item, name: "caller2" }] }); return; }
    if (scenario === "wrong-position") { write({ jsonrpc: "2.0", id: message.id, result: [{ ...item, selectionRange: { start: { ...item.selectionRange.start, character: item.selectionRange.start.character + 1 }, end: item.selectionRange.end } }] }); return; }
    if (scenario === "wrong-caller-document") { write({ jsonrpc: "2.0", id: message.id, result: [callerItem("barrel.ts")] }); return; }
    write({ jsonrpc: "2.0", id: message.id, result: [item] });
    if (scenario === "duplicate-id") write({ jsonrpc: "2.0", id: message.id, result: [item] });
    return;
  }
  if (message.method === "callHierarchy/outgoingCalls") {
    if (scenario === "hierarchy-null") { write({ jsonrpc: "2.0", id: message.id, result: null }); return; }
    if (scenario === "hierarchy-empty") { write({ jsonrpc: "2.0", id: message.id, result: [] }); return; }
    const [, callerText] = documentBySuffix("caller.ts") || [];
    const [, barrelText] = documentBySuffix("barrel.ts") || [];
    const caller = callerItem();
    const target = targetItem();
    if (!caller || JSON.stringify(message.params?.item) !== JSON.stringify(caller)) { write({ jsonrpc: "2.0", id: message.id, result: [] }); return; }
    const route = moduleRoute(callerText || "", barrelText || "");
    const ranges = callRanges(callerText || "", functionIdentity(callerText || "", "caller"), "target");
    if (scenario === "reordered") ranges.reverse();
    const validCall = route && ranges.length > 0 && target;
    const result = validCall ? [{ to: target, fromRanges: ranges }] : [];
    if (scenario === "late-response") {
      write({ jsonrpc: "2.0", id: message.id, result });
      write({ jsonrpc: "2.0", id: message.id, result });
      return;
    }
    if (scenario === "server-requests" && !(configurationChecked && applyEditChecked && progressChecked && messageResponses.size === 3)) {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Host server-request responses were incorrect" } });
      return;
    }
    write({ jsonrpc: "2.0", id: message.id, result }, scenario === "fragmented" ? "fragmented" : "normal");
    return;
  }
  if (message.method === "shutdown") {
    if (scenario === "slow-shutdown") setTimeout(() => write({ jsonrpc: "2.0", id: message.id, result: null }), 3_500);
    else write({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") {
    if (scenario === "delete-self") {
      try { process.getBuiltinModule("fs").unlinkSync(fileURLToPath(import.meta.url)); } catch {}
    }
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (message.method === "$/cancelRequest" && ["timeout", "cancel"].includes(scenario)) {
    setTimeout(() => process.exit(0), 10);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (expected === null) {
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker < 0) return;
      const header = buffer.subarray(0, marker).toString("ascii");
      const match = /Content-Length:\s*([0-9]+)/i.exec(header);
      if (!match) process.exit(32);
      expected = Number(match[1]);
      buffer = buffer.subarray(marker + 4);
    }
    if (buffer.length < expected) return;
    const payload = buffer.subarray(0, expected);
    buffer = buffer.subarray(expected);
    expected = null;
    respond(JSON.parse(payload.toString("utf8")));
  }
});

process.stdin.resume();

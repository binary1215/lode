#!/usr/bin/env node
import fs from "node:fs";
import { familyFormatForOriginal } from "./project-storage-format.mjs";

const MAXIMUM_WIRE_BYTES = 64 * 1024 * 1024;
const fail = (message, code, exitCode = 1, details = {}) => {
  fs.writeSync(1, JSON.stringify({ ok: false, error: { code, message, ...details } }));
  process.exit(exitCode);
};

const writeOutput = (value) => {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAXIMUM_WIRE_BYTES) {
    fail("ArcadeDB bridge output exceeds its bounded wire limit.", "ARCADEDB_REQUEST_FAILED");
  }
  fs.writeSync(1, encoded);
};

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAXIMUM_WIRE_BYTES) fail("ArcadeDB bridge input exceeds its bounded wire limit.", "ARCADEDB_BRIDGE_INVALID_INPUT");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("ArcadeDB bridge input is invalid JSON.", "ARCADEDB_BRIDGE_INVALID_INPUT"); }
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "ARCADEDB_BRIDGE_INVALID_INPUT");
  return value.trim();
}

const input = await readInput();
const endpoint = requiredText(input.endpoint, "ArcadeDB endpoint").replace(/\/$/, "");
const database = requiredText(input.database, "ArcadeDB database");
const usernameReference = requiredText(input.secretReferenceNames?.username, "ArcadeDB username reference");
const passwordReference = requiredText(input.secretReferenceNames?.password, "ArcadeDB password reference");
const operation = requiredText(input.operation, "ArcadeDB operation");
if (!new Set(["credential-status", "query", "query-batch", "command", "ready", "exists", "create-database", "drop-database"]).has(operation)) {
  fail("ArcadeDB bridge operation is unsupported.", "ARCADEDB_BRIDGE_INVALID_INPUT");
}
const username = process.env[usernameReference];
const password = process.env[passwordReference];
const timeoutMs = Number(input.timeoutMs ?? 15000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
  fail("ArcadeDB bridge timeout is invalid.", "ARCADEDB_BRIDGE_INVALID_INPUT");
}
if (operation === "credential-status") {
  const usernameReferencePresent = typeof username === "string" && username.length > 0;
  const passwordReferencePresent = typeof password === "string" && password.length > 0;
  writeOutput({
    ok: true,
    status: 200,
    body: {
      usernameReferencePresent,
      passwordReferencePresent,
      allReferencesPresent: usernameReferencePresent && passwordReferencePresent,
      credentialValuesReturned: false,
      networkRequestPerformed: false,
    },
  });
  process.exit(0);
}
if (!username || !password) fail("ArcadeDB credential references are unavailable in the process environment.", "ARCADEDB_CREDENTIALS_UNAVAILABLE", 2);

const queryBatch = operation === "query-batch" ? input.queries : null;
if (operation === "query-batch" && (!Array.isArray(queryBatch) || queryBatch.length < 1 || queryBatch.length > 8)) {
  fail("ArcadeDB query batch must contain from one through eight queries.", "ARCADEDB_BRIDGE_INVALID_INPUT");
}
if (operation === "query-batch" && (!familyFormatForOriginal("head-agent-core-arcadedb-query-batch", input) || input.protocol?.version !== "0.1.0")) {
  fail("ArcadeDB query batch protocol is incompatible.", "ARCADEDB_BRIDGE_INVALID_INPUT");
}

const path = operation === "ready"
  ? "/api/v1/ready"
  : operation === "exists"
    ? `/api/v1/exists/${encodeURIComponent(database)}`
    : operation === "create-database" || operation === "drop-database"
      ? "/api/v1/server"
      : `/api/v1/${operation}/${encodeURIComponent(database)}`;
const headers = {
  Accept: "application/json",
  Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
};
const readOnlyGet = operation === "ready" || operation === "exists";
const operationSignal = AbortSignal.timeout(timeoutMs);
const operationClass = ["command", "create-database", "drop-database"].includes(operation) ? "write" : "read";
const effectState = operationClass === "write" ? "maybe-applied" : "not-applicable";
function transportFailure(error) {
  return ["TimeoutError", "AbortError"].includes(error?.name)
    || ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(error?.code)
    || (error?.cause && transportFailure(error.cause));
}
function requestFailure(error, phase, status = 0) {
  const auth = status === 401 || status === 403;
  const unavailable = !auth && transportFailure(error);
  const code = auth ? "ARCADEDB_AUTHENTICATION_FAILED" : operationClass === "write" ? "ARCADEDB_WRITE_OUTCOME_UNKNOWN"
    : unavailable ? "ARCADEDB_TRANSPORT_UNAVAILABLE" : "ARCADEDB_REQUEST_FAILED";
  fail(auth ? "ArcadeDB authentication failed." : "ArcadeDB response was not completed.", code, unavailable && operationClass === "read" ? 2 : 1,
    { phase, operationClass, effectState, ...(status ? { httpStatus: status } : {}) });
}
let responseWireBytes = 0;
async function readBoundedResponseText(response) {
  if (!response.body) return "";
  const chunks = [];
  for await (const chunk of response.body) {
    responseWireBytes += chunk.length;
    if (responseWireBytes > MAXIMUM_WIRE_BYTES) {
      fail("ArcadeDB response exceeds its bounded wire limit.", "ARCADEDB_REQUEST_FAILED");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function performRequest({ requestPath, requestBody = null, method = "POST" }) {
  const requestHeaders = { ...headers };
  const request = { method, headers: requestHeaders, signal: operationSignal, redirect: "error" };
  if (requestBody != null) {
    requestHeaders["Content-Type"] = "application/json";
    request.body = JSON.stringify(requestBody);
  }
  let response;
  try { response = await fetch(`${endpoint}${requestPath}`, request); }
  catch (error) {
    requestFailure(error, "headers");
  }
  let responseText;
  try { responseText = await readBoundedResponseText(response); }
  catch (error) { requestFailure(error, "body", response.status); }
  let body = null;
  if (!responseText && response.ok && ["query", "query-batch"].includes(operation)) {
    fail("ArcadeDB query response is empty.", "ARCADEDB_REMOTE_RESPONSE_INVALID", 1, { phase: "decode", operationClass, effectState });
  }
  if (responseText) {
    try { body = JSON.parse(responseText); }
    catch {
      if (response.ok) fail("ArcadeDB response is not valid JSON.", "ARCADEDB_REMOTE_RESPONSE_INVALID", 1, { phase: "decode", operationClass, effectState });
      body = null;
    }
  }
  return { ok: response.ok, status: response.status, body };
}

if (operation === "query-batch") {
  const responses = [];
  let failedResponse = null;
  for (const [index, query] of queryBatch.entries()) {
    if (!query || typeof query !== "object" || Array.isArray(query)) {
      fail(`ArcadeDB query batch entry ${index} is invalid.`, "ARCADEDB_BRIDGE_INVALID_INPUT");
    }
    const language = requiredText(query.language ?? "sql", `ArcadeDB query batch entry ${index} language`);
    const command = requiredText(query.command, `ArcadeDB query batch entry ${index} command`);
    if (language.toLowerCase() !== "sql" || !/^select(?:\s|$)/iu.test(command)
      || command.includes(";") || command.includes("--") || command.includes("/*") || command.includes("*/")) {
      fail(`ArcadeDB query batch entry ${index} is not a bounded read-only SQL query.`, "ARCADEDB_BRIDGE_INVALID_INPUT");
    }
    const params = query.params && typeof query.params === "object" && !Array.isArray(query.params) ? query.params : {};
    const response = await performRequest({
      requestPath: `/api/v1/query/${encodeURIComponent(database)}`,
      requestBody: { language, command, params },
    });
    if (!response.ok) {
      failedResponse = { ...response, failedQueryIndex: index };
      break;
    }
    responses.push({ status: response.status, body: response.body });
  }
  writeOutput(failedResponse || { ok: true, status: 200, body: { responses } });
  process.exitCode = failedResponse ? 3 : 0;
} else {
  const requestBody = readOnlyGet
    ? null
    : operation === "create-database" || operation === "drop-database"
      ? { command: `${operation === "create-database" ? "create" : "drop"} database ${database}` }
      : {
        language: requiredText(input.language, "ArcadeDB language"),
        command: requiredText(input.command, "ArcadeDB command"),
        params: input.params && typeof input.params === "object" && !Array.isArray(input.params) ? input.params : {},
        ...(operation === "command" ? { autoCommit: true } : {}),
      };
  const response = await performRequest({ requestPath: path, requestBody, method: readOnlyGet ? "GET" : "POST" });
  writeOutput(response);
  process.exitCode = response.ok ? 0 : 3;
}

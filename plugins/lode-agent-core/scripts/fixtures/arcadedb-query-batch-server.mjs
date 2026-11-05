#!/usr/bin/env node
import http from "node:http";

let requestCount = 0;
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requestCount += 1;
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "invalid-json" }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/v1/query/head-benchmark"
    || request.headers.authorization !== `Basic ${Buffer.from("benchmark-reader:benchmark-secret").toString("base64")}`) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const result = body.command.includes("topologyJson")
    ? [{ topologyJson: "{\"kind\":\"benchmark-topology\"}" }]
    : [{ recordType: "HeadAgentGraphNode", nodeJson: "{\"nodeId\":\"node-1\"}", edgeJson: null, recordDepth: 0 }];
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ result }));
});

server.listen(0, "127.0.0.1", () => {
  if (typeof process.send === "function") process.send({ kind: "ready", port: server.address().port, pid: process.pid });
});

process.on("message", (message) => {
  if (message?.kind !== "shutdown") return;
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));

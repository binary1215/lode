// One worker of a two-process race on the shared proposal parents: waits for a
// common start, then creates and removes its own operational folder many times.
// Prints one JSON line: how many rounds ran and the codes of what threw.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [moduleFile, exportName, operationalRoot, projectId, authorizationId, roundsText, startFile] = process.argv.slice(2);
const build = (await import(pathToFileURL(moduleFile).href))[exportName];
const authorization = { projectId, authorizationId };
const errors = [];
// The failing call and path, so a red run explains itself.
const describe = (phase, error) =>
  `${phase}:${error.code || error.message}:${error.syscall || "-"}:${error.path ? path.basename(error.path) : "-"}:${error.path ? (fs.existsSync(error.path) ? "exists" : "gone") : "-"}`;
while (!fs.existsSync(startFile));
for (let round = 0; round < Number(roundsText); round++) {
  let folders = null;
  try {
    folders = build(operationalRoot, authorization);
  } catch (error) {
    errors.push(describe("create", error));
    continue;
  }
  try {
    if (folders.controlFile) fs.writeFileSync(folders.controlFile, "{}\n");
    folders.cleanup();
  } catch (error) {
    errors.push(describe("cleanup", error));
    // Leave no own folder behind for the next round.
    fs.rmSync(path.join(path.dirname(path.dirname(folders.controlFile)), authorizationId), { recursive: true, force: true });
  }
}
process.stdout.write(`${JSON.stringify({ rounds: Number(roundsText), errors })}\n`);

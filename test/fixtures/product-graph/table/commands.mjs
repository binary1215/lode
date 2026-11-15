// Synthetic command table for the product graph tests. Not a real product.
import { saveFile } from "./files.mjs";

const where = "./elsewhere.mjs";

function localHelper() {
  return 1;
}

function neverNamed() {
  return 0;
}

export const COMMANDS = [
  { command: "save", handler: saveFile },
  { command: "inline", run: () => localHelper() },
  { command: "lazy", load: () => import("./lazy.mjs").then((module) => module.runLazy) },
  { command: "broken", load: () => import(where).then((module) => module.go) },
  { command: "save", handler: saveFile },
];

program.register("deploy", buildProject);

function buildProject() {
  return localHelper();
}

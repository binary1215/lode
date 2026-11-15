// Synthetic table rows next to template literals with ${...}. Not a real product.
import { saveFile, loadFile, printFile } from "./template-handlers.mjs";
const product = "demo";
export const COMMANDS = [
  { name: "save", describe: `Saves ${product} files`, handler: saveFile },
  { name: "load", handler: loadFile },
  { name: "print", handler: (args) => printFile(`${args.name}.txt`) },
  { name: "last", handler: saveFile },
];
const banner = `v${1 + 1} ${`inner ${product}`}`;
function afterBanner() { return banner; }
registry.register("tail", afterBanner);

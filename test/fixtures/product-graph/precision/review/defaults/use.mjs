// Uses default exports through re-exports.
import run from "./lib/index.mjs";
import { other } from "./lib/index.mjs";

export function use() {
  run();
  other();
}

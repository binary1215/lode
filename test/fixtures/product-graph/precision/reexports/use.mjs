// Uses every re-export.
import { alpha, renamed, starry, d } from "./lib/index.mjs";
import { stepped } from "./lib/step.mjs";
import { loop } from "./lib/cycle-a.mjs";

export function run() {
  alpha();
  renamed();
  starry();
  d();
  stepped();
  loop();
}

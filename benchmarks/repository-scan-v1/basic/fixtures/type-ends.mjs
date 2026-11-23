// Parity cases for the JavaScript and Go repository scans (source analysis
// 0.3.4): a ternary whose first branch is a call is neither a method with a
// return type nor a lost call.
import { first } from "../src/main.mjs";

const flag = true;
const fallback = null;

export const api = {
  mode: flag ? first(1) : fallback,
  run() {
    first(2);
  },
};

export class Holder {
  value = flag ? first(3) : fallback
  run() {
    first(4);
  }
}

export const table = {
  a: flag ? first(5) : null,
  b: 2,
  go() {
    first(6);
  },
};

export function host(register) {
  register(flag ? first(7) : fallback, function () {
    first(8);
  });
}

export function guarded() {
  const x = flag ? first(9) : fallback
  try {
    first(x);
  } catch (error) {
    first(error);
  }
}

// Parity cases for the JavaScript and Go repository scans: class fields,
// class expressions, an anonymous default class, TypeScript signatures without
// a body, and text whose byte and UTF-16 lengths differ.
import {
  first as renamed,
} from "./main.mjs";

export class Odd {
  count = 0;
  onClick = () => this.multi(3, 4);
  static make = async (x) => {
    return renamed(x);
  };
  #hidden = function () {
    return 1;
  };
  handler = (e) =>
    this.multi(e, 1)
  value = compute();
  multi(a, b) {
    return a * b;
  }
}

export const Anonymous = class {
  run() {
    return 1;
  }
};

export default class extends Odd {
  go() {
    return this.render();
  }
}

export abstract class Shape {
  abstract render(): void;
  area(): number;
  area(scale?: number): number {
    return scale ?? 1;
  }
}

interface Port {
  run(): void;
  stop(code: number): Promise<void>;
}

class Zed extends mixin(
  class Alpha {
    foo() {}
  },
) {}

export class Generic {
  m<T extends "한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한" | "x">(v: T) {
    return v;
  }
}

export const table = {
  a: function /* 한한한한한한한한한한한한 */ name() {
    return 1;
  },
};

class Late
/* 한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한 */
{
  late() {
    return 2;
  }
}

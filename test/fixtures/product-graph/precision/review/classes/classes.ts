// Synthetic class-heavy code for the call-precision tests. Not a real product.
import { External } from "outside-package";

export class Odd {
  onClick = () => this.multi(3, 4);
  multi(a: number, b: number) {
    return a * b;
  }
}

export const Anonymous = class {
  run() {
    return 1;
  }
};

export abstract class Shape {
  abstract render(): void;
  draw(): void {
    this.render();
  }
}

export class Store {
  constructor(size: number) {
    this.size = size;
  }
}

// Members the declaration rule leaves out, but which are product names.
export function makeThing() {
  const inner = {
    nested() {
      return 1;
    },
    "quoted"() {
      return 2;
    },
  };
  return inner;
}

export function Legacy() {}
Legacy.prototype.legacyMethod = function () {
  return 3;
};

export interface Port {
  ping(): void;
}

export function useAll(thing, port: Port) {
  const odd = new Odd();
  odd.onClick();
  const anonymous = new Anonymous();
  anonymous.run();
  thing.nested();
  thing.quoted();
  thing.legacyMethod();
  port.ping();
  thing.nothingDefinesThis();
  const map = new Map();
  const outside = new External();
  return [map, outside];
}

export function direct() {
  return new Store(1);
}

// Parity cases for the JavaScript and Go repository scans: import lists over
// lines, class and object-literal members, and sites that look like method
// definitions but are calls.
import Main, {
  first,
  second as other, // a note
  /* a block */ third,
} from "./main.mjs";
import Whole, * as everything from "./whole.mjs";
import * as
  spread from "./spread.mjs";

export class Shelf extends Main {
  #count = 0;
  constructor(name) {
    super(name);
  }
  async load(id) {
    return this.#parse(await first(id));
  }
  static create(name) {
    return new Shelf(name);
  }
  *items() {
    yield 1;
  }
  get size() {
    return this.#count;
  }
  set size(value) {
    this.#count = value;
  }
  #parse(raw) {
    return other(raw);
  }
  typed<T>(value: T): Promise<T> {
    return third(value);
  }
}

export const tools = {
  run() {
    return everything.go();
  },
  stop: () => spread.halt(),
  go: function () {
    return Whole();
  },
  quick: (x) => x + 1,
};

export function choose(flag, root) {
  const picked = flag ? first({ root }) : other({ root });
  return `${third(picked)} and ${ { picked }.picked }`;
}

// Synthetic class and object-literal members for the call-precision tests.
import { Base } from "./base.mjs";

export class Store extends Base {
  #items = [];
  constructor(name) {
    super(name);
  }
  async load(id) {
    return this.#decode(await this.fetchRemote(id));
  }
  static create(name) {
    return new Store(name);
  }
  *entries() {
    yield 1;
  }
  get size() {
    return 0;
  }
  set size(value) {
    this.limit = value;
  }
  #decode(raw) {
    return raw;
  }
  save(item) {
    return this.count(item);
  }
  count() {
    return 0;
  }
}

export const api = {
  run() {
    return helper();
  },
  stop: () => helper(),
  go: function () {
    return helper();
  },
};

function helper() {
  return 1;
}

export function useAll() {
  const store = Store.create("x");
  const made = new Store("y");
  made.save(1);
  let later = new Store("z");
  later = Store.create("w");
  later.count();
  api.run();
  return store;
}

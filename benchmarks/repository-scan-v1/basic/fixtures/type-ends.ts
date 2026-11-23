// Parity cases for the JavaScript and Go repository scans (source analysis
// 0.3.4): where a TypeScript type ends. An annotation without an initializer
// never borrows a later "="; return types over several lines and conditional
// types keep their body.
import { first } from "../src/main.mjs";

type Foo = { a: string };
const thing = { handler: (a: unknown) => a };

let cache: Map<string, number>
const load = async (id: string) => {
  return first(id)
}

let count: number
thing.handler = (a) => {
  first(a);
};

let one: number, two = (x: number) => {
  first(x);
};

const typed: (a: number) => void = (a) => {
  first(a);
};

function pick<T>(x: T): T extends string ? { s: string } : { n: number } {
  return first(x);
}

function union(): Foo |
  null {
  return first();
}

function leading():
  | { a: string }
  | null {
  return first();
}

function check(x: unknown): asserts x is
  Foo {
  first(x);
}

export { cache, load, count, one, two, typed, pick, union, leading, check };

// Parity cases for the JavaScript and Go repository scans (source analysis
// 0.3.4): TypeScript type parameters, return types with "{", overloads,
// declare, methods and arrows.
import { first } from "../src/main.mjs";

type Handler = (a: unknown) => void;
interface Foo {
  a: string;
}

function generic<T extends { a: string }>(x: T): Promise<{ a: string }> {
  return first(x);
}

function literalReturn(): { a: string } {
  return first();
}

function isFoo(x: unknown): x is Foo {
  return first(x);
}

function overloaded(a: string): { a: string };
function overloaded(a: number): void;
function overloaded(a: any) {
  return first(a);
}

declare function declared(): void
function afterDeclare(options = {}) {
  return first(options);
}

class Loader {
  load(): Promise<{ a: string }> {
    return first();
  }
  get value(): { a: string } {
    return first();
  }
}

const callbackType = (cb: () => void) => {
  first(cb);
};

const returnType = async (a): Promise<void> => {
  first(a);
};

const annotated: Handler = (a) => {
  first(a);
};

const identity = <T,>(a: T) => a;

export { generic, literalReturn, isFoo, overloaded, afterDeclare, Loader, callbackType, returnType, annotated, identity };

// Parity cases for the JavaScript and Go repository scans (source analysis
// 0.3.4): a "{" inside a parameter list is not the function's body.
import { first } from "../src/main.mjs";

function withDefaults(a, options = {}) {
  return first(a, options);
}

function destructured({ a, b }) {
  return first(a, b);
}

function bothDefaults({ a } = {}, [b] = []) {
  return first(a, b);
}

function multiLine(
  a,
  { b } = {},
) {
  return first(a, b);
}

async function* generated({ a } = {}) {
  yield first(a);
}

export default function exported(options = {}) {
  return first(options);
}

const expression = function ({ a }) {
  return first(a);
};

const named = async function inner(a = {}) {
  return first(a);
};

const defaultCall = (a = first()) => {
  return first(a);
};

const single = (x) => first(x);

const invoked = (() => {
  function hidden() {}
  return hidden;
})();

function outer(options = {}) {
  function nested() {
    return first(options);
  }
  return nested();
}

// Same-line shapes: a container and a nested declaration starting on one
// line nest by offsets, never by lines.
function oneLine() { function innerOne() { first(); } innerOne(); }
const wrap = (x) => function wrapped() { return first(x); };
function twoA() { first(); } function twoB() { first(); }
const holder = { run: function () { first(); } };
class OneLine { go() { first(); } }
const arrowInArrow = () => () => first();
const both = function left() { first(); }, right = () => first();

export { withDefaults, destructured, bothDefaults, multiLine, generated, expression, named, defaultCall, single, invoked, outer, oneLine, wrap, twoA, twoB, holder, OneLine, arrowInArrow, both, right };

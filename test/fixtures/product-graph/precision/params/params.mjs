// A function held in a parameter or a local.
export function run(handler) {
  handler();
  return new Promise((resolve) => resolve());
}

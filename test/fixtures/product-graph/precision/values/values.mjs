// A module-level value binding that is called, and one that is not.
import { failWith } from "./errors.mjs";

export const fail = failWith("CHECK");
const unused = failWith("UNUSED");

export function check(value) {
  if (!value) fail("missing value");
  return unused;
}

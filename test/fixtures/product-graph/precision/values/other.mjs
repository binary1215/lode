// Calls the value binding through an import.
import { fail } from "./values.mjs";

export function guard(value) {
  if (!value) fail("other");
}

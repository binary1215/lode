// A file that imports a name called JSON.
import { codec as JSON } from "./codec.mjs";

export function readImported(text) {
  return JSON.parse(text);
}

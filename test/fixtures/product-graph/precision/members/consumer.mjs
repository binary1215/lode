// Uses the members through imports.
import { api, Store } from "./members.mjs";

export function consume() {
  api.stop();
  return Store.create("v");
}

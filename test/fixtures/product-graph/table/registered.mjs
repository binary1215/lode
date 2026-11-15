// Registration calls whose registrar is product code.
import { registry, program } from "./registry-framework.mjs";

function syncNow() {
  return 1;
}

function pushAll() {
  return 2;
}

registry.register("sync", syncNow);
program.command("push").action(pushAll);

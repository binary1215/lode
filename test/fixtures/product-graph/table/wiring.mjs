// Synthetic registration wiring for the product graph tests. Not a real product.

function openDoc() {
  return 1;
}

function closeDoc() {
  return 2;
}

function printDoc() {
  return 3;
}

function pluginPath(id) {
  return `./plugins/${id}.mjs`;
}

app.whenReady().then(() => { registry.register("open", openDoc); registry.register("close", closeDoc); });

(function setup() { registry.register("print", printDoc); })();

export const PLUGINS = [
  { name: "plugin", impl: (id) => import(pluginPath(id)).then((m) => m.run) },
];

// Light helpers over a product graph answer, loaded by the MCP server at
// startup (no build or graph module is imported here).

// Set on an answer whose whole `text` was rebuilt from its structured part and
// found equal, by the module that made the answer. A symbol key never reaches
// JSON.
export const PRODUCT_GRAPH_TEXT_FROM_STRUCTURE = Symbol.for("lode.productGraph.textFromStructure");

// Marks `value` when rebuild(value) gives back exactly its text.
export function markTextFromStructure(value, rebuild) {
  if (value && typeof value.text === "string" && rebuild(value) === value.text) value[PRODUCT_GRAPH_TEXT_FROM_STRUCTURE] = true;
  return value;
}

// What MCP structuredContent carries for a product graph answer: without the
// whole text when its structured part gives it back exactly (the content text
// still has it). An answer whose text could not be rebuilt keeps it.
export function productGraphStructuredContent(value) {
  if (!value || value[PRODUCT_GRAPH_TEXT_FROM_STRUCTURE] !== true || typeof value.text !== "string") return value;
  const { text: _text, ...rest } = value;
  return rest;
}

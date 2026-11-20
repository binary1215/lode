// Light helpers over a product graph query answer, loaded by the MCP server
// at startup (no build or graph module is imported here).

// What MCP structuredContent carries for an answer: without the whole text when
// the header, title and rows give it back exactly (the content text still has
// it). An answer whose text says more than its rows keeps it.
export function productGraphStructuredContent(value) {
  if (!value || typeof value.text !== "string" || !Array.isArray(value.rows) || !Array.isArray(value.header) || typeof value.title !== "string") return value;
  const rebuilt = [...value.header, value.title, ...value.rows.map((row) => `${"  ".repeat(row.depth)}${row.text}`)].join("\n") + "\n";
  if (rebuilt !== value.text) return value;
  const { text: _text, ...rest } = value;
  return rest;
}

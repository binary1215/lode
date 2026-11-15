// Built-in calls: none of them can be product code.
export function work(items, text) {
  const value = JSON.parse(text);
  items.map(work);
  String(value);
  setTimeout(work);
  customGlobal();
  return value;
}

// A file that declares its own JSON: JSON.parse here is product code.
const JSON = {
  parse(text) {
    return text;
  },
};

export function readOwn(text) {
  return JSON.parse(text);
}

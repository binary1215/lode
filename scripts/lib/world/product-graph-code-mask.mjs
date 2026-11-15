// Which characters of a file are code, for the product graph's UI binding
// scan. A small lexer per language family: comments and string contents are
// not code; the ${...} parts of a JavaScript template literal are. It is a
// lexer, not a parser: a regular expression literal is recognised from the
// character before it, and an unterminated string ends at its line.

export function codeMaskKind(extension) {
  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts"].includes(extension)) return "javascript";
  if (extension === ".py") return "python";
  if ([".html", ".htm", ".vue", ".svelte"].includes(extension)) return "markup";
  return null;
}

// Returns a Uint8Array: 1 where the character is code, 0 in comments and
// string contents. With no known kind, every character counts as code.
export function codeMask(text, kind) {
  const mask = new Uint8Array(text.length).fill(1);
  const blank = (from, to) => mask.fill(0, from, Math.min(to, text.length));
  if (kind === "markup") {
    for (let open = text.indexOf("<!--"); open >= 0; open = text.indexOf("<!--", open + 4)) {
      const close = text.indexOf("-->", open + 4);
      blank(open, close < 0 ? text.length : close + 3);
      if (close < 0) break;
    }
    return mask;
  }
  if (kind === "python") {
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === "#") {
        const end = text.indexOf("\n", index);
        blank(index, end < 0 ? text.length : end);
        index = end < 0 ? text.length : end;
      } else if (character === '"' || character === "'") {
        const triple = text.startsWith(character.repeat(3), index);
        const quote = triple ? character.repeat(3) : character;
        let end = index + quote.length;
        while (end < text.length) {
          if (text[end] === "\\") end += 2;
          else if (text.startsWith(quote, end)) break;
          else if (!triple && text[end] === "\n") break;
          else end += 1;
        }
        blank(index, end + (text.startsWith(quote, end) ? quote.length : 0));
        index = end + quote.length - 1;
      }
    }
    return mask;
  }
  if (kind !== "javascript") return mask;
  // Stack of template-literal expression depths: each entry counts open
  // braces inside one ${...}.
  const expressions = [];
  let previous = "";
  const regexAllowedAfter = "(,=:[!&|?{};+-*%<>~^";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      blank(index, end < 0 ? text.length : end);
      index = end < 0 ? text.length : end - 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      blank(index, end < 0 ? text.length : end + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (character === '"' || character === "'") {
      let end = index + 1;
      while (end < text.length && text[end] !== character && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1;
      blank(index, end + 1);
      index = end;
      previous = character;
      continue;
    }
    if (character === "/" && (previous === "" || regexAllowedAfter.includes(previous))) {
      let end = index + 1,
        inClass = false;
      while (end < text.length && text[end] !== "\n" && (inClass || text[end] !== "/")) {
        if (text[end] === "\\") end += 1;
        else if (text[end] === "[") inClass = true;
        else if (text[end] === "]") inClass = false;
        end += 1;
      }
      blank(index, end + 1);
      index = end;
      previous = "/";
      continue;
    }
    if (character === "`" || (character === "}" && expressions.length && expressions.at(-1) === 0)) {
      // Template text runs to the closing backtick or the next ${.
      if (character === "}") expressions.pop();
      let end = index + 1;
      while (end < text.length && text[end] !== "`" && !(text[end] === "$" && text[end + 1] === "{")) end += text[end] === "\\" ? 2 : 1;
      blank(index, end + (text[end] === "`" ? 1 : 0));
      if (text[end] === "$") {
        mask[end] = 1;
        mask[end + 1] = 1;
        expressions.push(0);
        index = end + 1;
      } else index = end;
      previous = "`";
      continue;
    }
    if (character === "{" && expressions.length) expressions[expressions.length - 1] += 1;
    else if (character === "}" && expressions.length) expressions[expressions.length - 1] -= 1;
    if (!/\s/.test(character)) previous = character;
  }
  return mask;
}

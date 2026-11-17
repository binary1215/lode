// Lexer parity cases for the JavaScript and Go repository scans. CRLF line ends,
// a non-BMP character, a no-break space and an escaped lone surrogate on purpose.
const nested = `outer ${`inner ${value("x")}`} end`;
function afterNested() { return helper(); }
const pattern = /["'`]/g;
function afterRegex(text) { return text.replace(/["'`]/g, "") + helper(); }
function afterReturn(text) {
  return /["'`]/.test(text) && helper();
}
function afterWideSpace(text) {
  return /'/.test(text) && helper();
}
const wide = "😀 \uD83D";
const emojiTemplate = `😀${helper()}😀`;
/* it's "quoted" and `ticked` 😀 */
const url = "http://example.test";
export function* rows() { yield helper(); }
function helper() { return 1; }

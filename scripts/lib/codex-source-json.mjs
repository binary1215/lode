// Source JSON may contain exact decimals that a JavaScript/SDK JSON number
// cannot round-trip. Keep original bytes in the capture; never silently certify
// a rounded tool input/result. Formatting-only numeric differences are allowed.
function decimal(value) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return null;
  let digits = (match[2] + (match[3] || "")).replace(/^0+/, "");
  if (!digits) return match[1] + "0";
  const exponent = match[4] || "0";
  // Nonzero finite JSON numbers cannot require a giant exponent after the
  // already-bounded source token has been read. Do not allocate huge BigInts.
  if (exponent.replace(/^[+-]/, "").length > 16) return null;
  const trailing = /0*$/.exec(digits)[0].length;
  if (trailing) digits = digits.slice(0, -trailing);
  return match[1] + digits + "e" + (BigInt(exponent) - BigInt((match[3] || "").length) + BigInt(trailing));
}

export function parseCodexSourceJson(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === "number" && (!Number.isFinite(value)
      || decimal(context.source) !== decimal(JSON.stringify(value)))) {
      throw Object.assign(new Error("Codex source numeric precision cannot be preserved by this JSON reader."),
        { code: "CODEX_SOURCE_NUMERIC_PRECISION_UNQUALIFIED" });
    }
    return value;
  });
}

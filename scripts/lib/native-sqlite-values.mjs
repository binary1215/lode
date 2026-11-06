const fail = (code, message = code) => {
  throw Object.assign(new Error(message), { code });
};
const shape = (value, fields) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === fields.slice().sort().join(",");
const integer = (value) =>
  typeof value === "string" &&
  /^-?(?:0|[1-9][0-9]*)$/.test(value) &&
  value !== "-0" &&
  BigInt(value) >= -(1n << 63n) &&
  BigInt(value) < 1n << 63n;
const base64 = (value) =>
  typeof value === "string" && Buffer.from(value, "base64").toString("base64") === value;

// SQLite logical cell values, not a byte-for-byte database image. The caller
// reads typeof(column) and raw TEXT bytes in the same selected transaction.
// No source DDL, JS-number integer narrowing, lossy TEXT or policy is imported.
export function encodeSqliteCell(type, value, rawTextHex = null) {
  if (type === "null" && value === null) return { type };
  if (type === "integer" && typeof value === "bigint" && integer(String(value)))
    return { type, value: String(value) };
  if (type === "real" && typeof value === "number" && !Number.isNaN(value)) {
    const bits = Buffer.alloc(8);
    bits.writeDoubleBE(value);
    return { type, ieee754: bits.toString("hex") };
  }
  if (type === "blob" && value instanceof Uint8Array)
    return { type, base64: Buffer.from(value).toString("base64") };
  if (
    type === "text" &&
    typeof value === "string" &&
    typeof rawTextHex === "string" &&
    /^(?:[a-fA-F0-9]{2})*$/.test(rawTextHex)
  ) {
    const raw = Buffer.from(rawTextHex, "hex");
    let decoded;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      fail("NATIVE_SQLITE_TEXT_NOT_ROUNDTRIPPABLE");
    }
    if (decoded !== value || !Buffer.from(value, "utf8").equals(raw))
      fail("NATIVE_SQLITE_TEXT_NOT_ROUNDTRIPPABLE");
    return { type, value, utf8: raw.toString("base64") };
  }
  fail("NATIVE_SQLITE_CELL_UNSUPPORTED");
}

export function decodeSqliteCell(cell) {
  if (shape(cell, ["type"]) && cell.type === "null") return null;
  if (shape(cell, ["type", "value"]) && cell.type === "integer" && integer(cell.value))
    return BigInt(cell.value);
  if (
    shape(cell, ["type", "ieee754"]) &&
    cell.type === "real" &&
    typeof cell.ieee754 === "string" &&
    /^[a-f0-9]{16}$/.test(cell.ieee754)
  ) {
    const number = Buffer.from(cell.ieee754, "hex").readDoubleBE();
    if (!Number.isNaN(number)) return number;
  }
  if (shape(cell, ["type", "base64"]) && cell.type === "blob" && base64(cell.base64))
    return Buffer.from(cell.base64, "base64");
  if (
    shape(cell, ["type", "value", "utf8"]) &&
    cell.type === "text" &&
    typeof cell.value === "string" &&
    base64(cell.utf8)
  ) {
    const raw = Buffer.from(cell.utf8, "base64");
    const encoded = encodeSqliteCell("text", cell.value, raw.toString("hex"));
    if (encoded.utf8 === cell.utf8) return cell.value;
  }
  fail("NATIVE_SQLITE_CELL_INVALID");
}

const identifier = (name) => {
  if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
    fail("NATIVE_SQLITE_IDENTIFIER_INVALID");
  return '"' + name + '"';
};

// Columns and selected-table SQL come from a verified, installed-engine profile.
// This helper never opens a home/database and never executes a mutation.
function* iterateEncodedSqliteRows(
  database,
  table,
  columns,
  { where = "", parameters = [], orderBy = [] } = {},
  encode = encodeSqliteCell,
) {
  if (!Array.isArray(columns) || !columns.length || new Set(columns).size !== columns.length)
    fail("NATIVE_SQLITE_COLUMNS_INVALID");
  const projection = columns
    .flatMap((column, index) => {
      const name = identifier(column);
      return [
        name + " AS c" + index,
        "typeof(" + name + ") AS t" + index,
        "CASE WHEN typeof(" +
          name +
          ")='text' THEN hex(CAST(" +
          name +
          " AS BLOB)) END AS h" +
          index,
      ];
    })
    .join(",");
  // Only the profile-owned selection shape is supported, not caller SQL.
  if (
    !["", 'WHERE "thread_id" = ?', 'WHERE "id" = ?', 'WHERE "project_id" = ?'].includes(where) ||
    parameters.length !== (where ? 1 : 0)
  )
    fail("NATIVE_SQLITE_SELECTION_INVALID");
  if (
    !Array.isArray(orderBy) ||
    new Set(orderBy).size !== orderBy.length ||
    orderBy.some((name) => !columns.includes(name))
  )
    fail("NATIVE_SQLITE_SELECTION_INVALID");
  const ordering = orderBy.length ? " ORDER BY " + orderBy.map(identifier).join(",") : "";
  const statement = database.prepare(
    "SELECT " + projection + " FROM " + identifier(table) + " " + where + ordering,
  );
  statement.setReadBigInts(true);
  for (const row of statement.iterate(...parameters))
    yield columns.map((_, index) => encode(row["t" + index], row["c" + index], row["h" + index]));
}

export function* iterateTypedSqliteRows(database, table, columns, options = {}) {
  yield* iterateEncodedSqliteRows(database, table, columns, options);
}
// Backup comparison preserves opaque SQLite TEXT bytes too. These digest-only
// cells cannot be decoded/applied as normal transferred native row cells.
export function* iterateSqliteStorageRows(database, table, columns, options = {}) {
  yield* iterateEncodedSqliteRows(database, table, columns, options, (type, value, textHex) =>
    type === "text"
      ? { type: "raw-text-bytes", hex: textHex }
      : encodeSqliteCell(type, value, textHex),
  );
}

export function readTypedSqliteRows(database, table, columns, options = {}) {
  const rows = [];
  let encodedBytes = 2;
  for (const row of iterateTypedSqliteRows(database, table, columns, options)) {
    encodedBytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (encodedBytes > 512 * 1024 * 1024) fail("NATIVE_SQLITE_TRANSFER_LIMIT");
    rows.push(row);
  }
  return rows;
}

// Lossless JSON transport for this offline view only. IDs, owners, revisions,
// array multiplicity and source states are values, never semantic merge keys.
const explorerEncoding = "lode-explorer-json-table-v3";
const codecError = () => { throw new Error("GRAPH_EXPLORER_INVALID_DATA_TABLE"); };
export const explorerCodec = {
  encode(value) {
    const strings = [], schemas = [], objects = [], arrays = [];
    const stringIds = new Map(), schemaIds = new Map(), objectIds = new Map(), arrayIds = new Map();
    const references = new WeakMap(), visiting = new WeakSet();
    const stringId = text => { if (!stringIds.has(text)) { stringIds.set(text, strings.length); strings.push(text); } return stringIds.get(text); };
    const reference = (id, kind) => -(id * 3 + kind + 1);
    function pack(input) {
      if (input === null || typeof input === "boolean") return input;
      if (typeof input === "number") return Number.isFinite(input) ? input < 0 ? ["n", input] : input : null;
      if (typeof input === "string") return reference(stringId(input), 0);
      if (!input || typeof input !== "object") return null;
      if (references.has(input)) return references.get(input);
      if (visiting.has(input)) codecError();
      visiting.add(input);
      const array = Array.isArray(input);
      let row;
      if (array) row = input.map(item => pack(item));
      else {
        const entries = Object.entries(input).filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol");
        const schema = entries.map(([key]) => stringId(key)), schemaKey = JSON.stringify(schema);
        if (!schemaIds.has(schemaKey)) { schemaIds.set(schemaKey, schemas.length); schemas.push(schema); }
        row = [schemaIds.get(schemaKey)];
        for (const [, item] of entries) row.push(pack(item));
      }
      const key = JSON.stringify(row), table = array ? arrays : objects, ids = array ? arrayIds : objectIds;
      if (!ids.has(key)) { ids.set(key, table.length); table.push(row); }
      const result = reference(ids.get(key), array ? 2 : 1);
      references.set(input, result); visiting.delete(input); return result;
    }
    const root = pack(value);
    const groups = new Map();
    objects.forEach((row, index) => { if (!groups.has(row[0])) groups.set(row[0], []); groups.get(row[0]).push(index); });
    for (const [schemaId, indices] of groups) {
      if (indices.length < 2) continue;
      const keys = schemas[schemaId], defaults = [], words = Math.ceil(keys.length / 30);
      for (let field = 0; field < keys.length; field++) {
        const frequencies = new Map(); let best = -1;
        for (const index of indices) {
          const value = objects[index][field + 1], key = Array.isArray(value) ? `n:${value[1]}` : value;
          const count = (frequencies.get(key) || 0) + 1; frequencies.set(key, count);
          if (count > best) { best = count; defaults[field] = value; }
        }
      }
      const schema = { keys, defaults }, replacements = [];
      let originalBytes = JSON.stringify(keys).length, compactBytes = JSON.stringify(schema).length;
      for (const index of indices) {
        const original = objects[index], masks = Array(words).fill(0), values = [];
        for (let field = 0; field < keys.length; field++) {
          const value = original[field + 1], expected = defaults[field];
          if (value === expected || Array.isArray(value) && Array.isArray(expected) && value[1] === expected[1]) continue;
          masks[Math.floor(field / 30)] |= 1 << (field % 30); values.push(value);
        }
        const row = [schemaId].concat(masks, values); replacements.push([index, row]);
        originalBytes += JSON.stringify(original).length; compactBytes += JSON.stringify(row).length;
      }
      // Choose a shorter representation by actual serialized size, not a node
      // cutoff or a semantic default. Every omitted cell is restored exactly.
      if (compactBytes < originalBytes) { schemas[schemaId] = schema; for (const [index, row] of replacements) objects[index] = row; }
    }
    return { encoding: explorerEncoding, strings, schemas, objects, arrays, root };
  },
  decode(envelope) {
    if (envelope?.encoding !== explorerEncoding) return envelope;
    const { strings, schemas, objects, arrays } = envelope;
    if (![strings, schemas, objects, arrays].every(Array.isArray) || strings.some(value => typeof value !== "string")) codecError();
    const fields = schemas.map(schema => {
      const keys = Array.isArray(schema) ? schema : schema?.keys;
      if (!Array.isArray(keys) || keys.some(id => !Number.isInteger(id) || id < 0 || id >= strings.length) || new Set(keys).size !== keys.length) codecError();
      if (!Array.isArray(schema) && (!Array.isArray(schema.defaults) || schema.defaults.length !== keys.length)) codecError();
      return keys.map(id => strings[id]);
    });
    const visiting = new Set();
    function unpack(value) {
      if (value === null || typeof value === "boolean") return value;
      if (Array.isArray(value)) {
        if (value.length === 2 && value[0] === "n" && typeof value[1] === "number" && Number.isFinite(value[1]) && value[1] < 0) return value[1];
        return codecError();
      }
      if (typeof value !== "number" || !Number.isFinite(value)) return codecError();
      if (value >= 0) return value;
      if (!Number.isSafeInteger(value)) return codecError();
      const packed = -value - 1, kind = packed % 3, id = (packed - kind) / 3;
      const table = kind === 0 ? strings : kind === 1 ? objects : arrays;
      if (id >= table.length) return codecError();
      if (kind === 0) return table[id];
      const row = table[id];
      if (!Array.isArray(row) || visiting.has(value)) codecError();
      visiting.add(value);
      let result;
      if (kind === 2) result = row.map(unpack);
      else {
        const keys = fields[row[0]];
        if (!Number.isInteger(row[0]) || !keys) codecError();
        const schema = schemas[row[0]], compact = !Array.isArray(schema), words = compact ? Math.ceil(keys.length / 30) : 0;
        if (compact) {
          if (row.length < words + 1) codecError();
          for (let word = 0; word < words; word++) if (!Number.isInteger(row[word + 1]) || row[word + 1] < 0 || row[word + 1] >= 2 ** 30) codecError();
          if (keys.length % 30 && row[words] >= 2 ** (keys.length % 30)) codecError();
        } else if (row.length !== keys.length + 1) codecError();
        let cursor = words + 1;
        result = {};
        for (let index = 0; index < keys.length; index++) {
          const overridden = !compact || Boolean(row[Math.floor(index / 30) + 1] & 1 << (index % 30));
          const field = keys[index], child = unpack(overridden ? row[cursor++] : schema.defaults[index]);
          if (field === "__proto__") Object.defineProperty(result, field, { value: child, enumerable: true, writable: true, configurable: true });
          else result[field] = child;
        }
        if (cursor !== row.length) codecError();
      }
      visiting.delete(value);
      // Fresh objects preserve independent JSON array occurrences, including
      // equal parallel edges without IDs. There is no evidence deduplication.
      return result;
    }
    return unpack(envelope.root);
  },
};

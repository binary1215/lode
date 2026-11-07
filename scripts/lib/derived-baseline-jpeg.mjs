import { SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";

// A narrow baseline JPEG integrity reader: no filesystem, decoder install,
// raster allocation, IDCT, color interpretation or provider-processing claim.
// It validates every entropy-coded coefficient for one interleaved 8-bit scan.
// Format references: ITU T.81 Annex B/C/F; https://go.dev/src/image/jpeg/scan.go
export function inspectDerivedBaselineJpeg(bytes) {
  const reject = code => { throw Object.assign(new Error(code), { code }); };
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216)
      reject("DERIVED_JPEG_SIGNATURE_INVALID");
    if (bytes.length > SNAPSHOT_STORAGE_LIMITS.decodedBytes) reject("DERIVED_JPEG_INPUT_LIMIT");
    let offset = 2, frame = null;
    const quant = new Set(), huffman = new Map();
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) reject("DERIVED_JPEG_MARKER_INVALID");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0 || marker === 216 || marker === 217 || marker >= 208 && marker <= 215)
        reject("DERIVED_JPEG_MARKER_INVALID");
      if (offset + 2 > bytes.length) reject("DERIVED_JPEG_SEGMENT_TRUNCATED");
      const length = bytes.readUInt16BE(offset), end = offset + length;
      if (length < 2 || end > bytes.length) reject("DERIVED_JPEG_SEGMENT_TRUNCATED");
      let cursor = offset + 2;
      if (marker === 219) {
        while (cursor < end) {
          const selector = bytes[cursor++];
          if (selector > 3 || cursor + 64 > end || quant.has(selector)) reject("DERIVED_JPEG_QUANTIZATION_UNQUALIFIED");
          for (let i = 0; i < 64; i++) if (!bytes[cursor++]) reject("DERIVED_JPEG_QUANTIZATION_INVALID");
          quant.add(selector);
        }
      } else if (marker === 196) {
        while (cursor < end) {
          const selector = bytes[cursor++], kind = selector >>> 4, index = selector & 15;
          if (kind > 1 || index > 3 || cursor + 16 > end || huffman.has(selector)) reject("DERIVED_JPEG_HUFFMAN_UNQUALIFIED");
          const counts = [...bytes.subarray(cursor, cursor + 16)]; cursor += 16;
          const count = counts.reduce((a, b) => a + b, 0);
          if (!count || count > 256 || cursor + count > end) reject("DERIVED_JPEG_HUFFMAN_INVALID");
          const symbols = [...bytes.subarray(cursor, cursor + count)]; cursor += count;
          if (new Set(symbols).size !== symbols.length || symbols.some(value => kind === 0 ? value > 11
            : (value & 15) > 10 || (value & 15) === 0 && value !== 0 && value !== 240)) reject("DERIVED_JPEG_HUFFMAN_INVALID");
          let code = 0, symbol = 0;
          const levels = [];
          for (let bits = 1; bits <= 16; bits++) {
            const n = counts[bits - 1];
            // A JPEG Huffman code cannot be all ones (entropy fill bits).
            if (code + n >= 2 ** bits) reject("DERIVED_JPEG_HUFFMAN_INVALID");
            levels.push({ first: code, count: n, symbol }); symbol += n; code = (code + n) * 2;
          }
          huffman.set(selector, { levels, symbols });
        }
      } else if (marker === 192) {
        if (frame || length < 8 || bytes[cursor++] !== 8) reject("DERIVED_JPEG_FRAME_UNQUALIFIED");
        const height = bytes.readUInt16BE(cursor), width = bytes.readUInt16BE(cursor + 2); cursor += 4;
        const n = bytes[cursor++];
        if (!width || !height || ![1, 3].includes(n) || length !== 8 + 3 * n) reject("DERIVED_JPEG_FRAME_UNQUALIFIED");
        if (BigInt(width) * BigInt(height) * 4n > BigInt(SNAPSHOT_STORAGE_LIMITS.decodedBytes)) reject("DERIVED_JPEG_DECODE_STORAGE_LIMIT");
        const components = [];
        for (let i = 0; i < n; i++) {
          const id = bytes[cursor++], sample = bytes[cursor++], table = bytes[cursor++], h = sample >>> 4, v = sample & 15;
          if (!h || !v || h > 4 || v > 4 || table > 3 || components.some(component => component.id === id))
            reject("DERIVED_JPEG_FRAME_UNQUALIFIED");
          components.push({ id, h, v, table });
        }
        if (components.reduce((sum, component) => sum + component.h * component.v, 0) > 10)
          reject("DERIVED_JPEG_FRAME_UNQUALIFIED");
        // This profile excludes non-interleaved scans and unusual grayscale sampling.
        if (n === 1 && (components[0].h !== 1 || components[0].v !== 1)) reject("DERIVED_JPEG_FRAME_UNQUALIFIED");
        frame = { width, height, components };
      } else if (marker === 218) {
        if (!frame || bytes[cursor++] !== frame.components.length || length !== 6 + 2 * frame.components.length)
          reject("DERIVED_JPEG_SCAN_UNQUALIFIED");
        const scan = [];
        for (let i = 0; i < frame.components.length; i++) {
          const id = bytes[cursor++], tables = bytes[cursor++], component = frame.components.find(value => value.id === id);
          const dc = huffman.get(tables >>> 4), ac = huffman.get(16 + (tables & 15));
          if (!component || scan.some(value => value.component.id === id) || !quant.has(component.table) || !dc || !ac)
            reject("DERIVED_JPEG_SCAN_UNQUALIFIED");
          scan.push({ component, dc, ac });
        }
        if (bytes[cursor++] !== 0 || bytes[cursor++] !== 63 || bytes[cursor++] !== 0 || cursor !== end)
          reject("DERIVED_JPEG_SCAN_UNQUALIFIED");
        let position = end, current = 0, remaining = 0, blocks = 0;
        const bit = () => {
          if (!remaining) {
            if (position >= bytes.length) reject("DERIVED_JPEG_ENTROPY_TRUNCATED");
            current = bytes[position++];
            if (current === 255 && bytes[position++] !== 0) reject("DERIVED_JPEG_ENTROPY_MARKER_INVALID");
            remaining = 8;
          }
          return current >>> --remaining & 1;
        };
        const decode = table => {
          let code = 0;
          for (let length = 1; length <= 16; length++) {
            code = code * 2 + bit(); const level = table.levels[length - 1], i = code - level.first;
            if (i >= 0 && i < level.count) return table.symbols[level.symbol + i];
          }
          reject("DERIVED_JPEG_ENTROPY_CODE_INVALID");
        };
        const skip = count => { while (count--) bit(); };
        const maxH = Math.max(...frame.components.map(value => value.h)), maxV = Math.max(...frame.components.map(value => value.v));
        const mcus = Math.ceil(frame.width / (8 * maxH)) * Math.ceil(frame.height / (8 * maxV));
        for (let mcu = 0; mcu < mcus; mcu++) for (const { component, dc, ac } of scan)
          for (let block = 0; block < component.h * component.v; block++) {
            skip(decode(dc)); let coefficient = 1;
            while (coefficient < 64) {
              const value = decode(ac), run = value >>> 4, size = value & 15;
              if (!size) {
                if (!run) break;
                coefficient += 16;
                if (coefficient > 64) reject("DERIVED_JPEG_COEFFICIENT_RUN_INVALID");
              } else {
                coefficient += run;
                if (coefficient >= 64) reject("DERIVED_JPEG_COEFFICIENT_RUN_INVALID");
                skip(size); coefficient++;
              }
            }
            blocks++;
          }
        if (remaining && (current & (2 ** remaining - 1)) !== 2 ** remaining - 1) reject("DERIVED_JPEG_ENTROPY_PADDING_INVALID");
        if (position !== bytes.length - 2 || bytes[position] !== 255 || bytes[position + 1] !== 217)
          reject("DERIVED_JPEG_END_INVALID");
        return { valid: true, profile: "jpeg-baseline-huffman-coefficients-v1", width: frame.width, height: frame.height,
          components: frame.components.length, mcus, coefficientBlocks: blocks, entropyValidated: true,
          rasterDecoded: false, originalBytesPreserved: true, providerImageProcessingVerified: false };
      } else if (!(marker >= 224 && marker <= 239 || marker === 254)) reject("DERIVED_JPEG_MARKER_UNQUALIFIED");
      offset = end;
    }
    reject("DERIVED_JPEG_END_INVALID");
  } catch (error) {
    if (!error.code?.startsWith("DERIVED_JPEG_")) throw error;
    return { valid: false, code: error.code, originalBytesPreserved: true, providerImageProcessingVerified: false };
  }
}

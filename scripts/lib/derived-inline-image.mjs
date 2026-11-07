import { inflateSync } from "node:zlib";
import { SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";
import { inspectDerivedBaselineJpeg } from "./derived-baseline-jpeg.mjs";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
const invalid = code => ({ valid: false, code, originalBytesPreserved: true, providerImageProcessingVerified: false });

// Bounded provider-independent integrity checks, not visual/model tests.
// The default PNG profile remains unchanged. A separate explicit profile adds
// baseline JPEG entropy validation; other codecs remain unqualified, not absent.
export function inspectDerivedInlineImage(mediaType, bytes, profile = "png-v1") {
  if (!["png-v1", "png-and-baseline-jpeg-v1"].includes(profile)) return invalid("DERIVED_IMAGE_VALIDATION_PROFILE_UNQUALIFIED");
  if (mediaType === "image/jpeg" && profile === "png-and-baseline-jpeg-v1") return inspectDerivedBaselineJpeg(bytes);
  if (mediaType !== "image/png") return invalid("DERIVED_IMAGE_CODEC_VALIDATION_UNQUALIFIED");
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) return invalid("DERIVED_PNG_SIGNATURE_INVALID");
  let offset = 8, header = null, ended = false, dataStarted = false, dataEnded = false, paletteEntries = 0;
  const compressed = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return invalid("DERIVED_PNG_CHUNK_TRUNCATED");
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) return invalid("DERIVED_PNG_CHUNK_TRUNCATED");
    const typeBytes = bytes.subarray(offset + 4, offset + 8), type = typeBytes.toString("ascii"), data = bytes.subarray(offset + 8, end - 4);
    if (!typeBytes.every(byte => byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122)
      || typeBytes[2] & 32) return invalid("DERIVED_PNG_CHUNK_TYPE_INVALID");
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return invalid("DERIVED_PNG_CRC_INVALID");
    if (!header && type !== "IHDR") return invalid("DERIVED_PNG_HEADER_INVALID");
    if (type === "IHDR") {
      if (header || length !== 13) return invalid("DERIVED_PNG_HEADER_INVALID");
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4), depth = data[8], color = data[9], interlace = data[12];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[color]?.includes(depth)
        || data[10] !== 0 || data[11] !== 0 || interlace > 1) return invalid("DERIVED_PNG_HEADER_INVALID");
      header = { width, height, depth, color, interlace };
    } else if (type === "PLTE") {
      if (dataStarted || paletteEntries || !length || length % 3 || length > 768 || [0, 4].includes(header.color)) return invalid("DERIVED_PNG_PALETTE_INVALID");
      paletteEntries = length / 3;
    } else if (type === "IDAT") {
      if (dataEnded || header.color === 3 && (!paletteEntries || paletteEntries > 2 ** header.depth)) return invalid("DERIVED_PNG_DATA_ORDER_INVALID");
      dataStarted = true; compressed.push(data);
    } else if (type === "IEND") {
      if (length || !dataStarted || end !== bytes.length) return invalid("DERIVED_PNG_END_INVALID");
      ended = true;
    } else {
      if (!(typeBytes[0] & 32)) return invalid("DERIVED_PNG_CRITICAL_CHUNK_UNQUALIFIED");
      if (dataStarted) dataEnded = true;
      // Animation needs additional frame validation; don't overclaim it.
      if (["acTL", "fcTL", "fdAT"].includes(type)) return invalid("DERIVED_PNG_ANIMATION_UNQUALIFIED");
    }
    offset = end;
  }
  if (!ended || !header) return invalid("DERIVED_PNG_END_INVALID");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.color];
  const passes = header.interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = []; let expected = 0n;
  for (const [x, y, dx, dy] of passes) {
    const width = Math.max(0, Math.ceil((header.width - x) / dx)), height = Math.max(0, Math.ceil((header.height - y) / dy));
    if (!width || !height) continue;
    const stride = (BigInt(width) * BigInt(channels * header.depth) + 7n) / 8n + 1n;
    expected += stride * BigInt(height); rows.push({ stride: Number(stride), height });
  }
  if (expected > BigInt(SNAPSHOT_STORAGE_LIMITS.decodedBytes)) return invalid("DERIVED_PNG_DECODE_STORAGE_LIMIT");
  let decoded;
  try {
    const input = Buffer.concat(compressed), result = inflateSync(input, { maxOutputLength: Number(expected) + 1, info: true });
    if (result.engine.bytesWritten !== input.length) return invalid("DERIVED_PNG_DEFLATE_TRAILING_DATA");
    decoded = result.buffer;
  } catch { return invalid("DERIVED_PNG_DEFLATE_INVALID"); }
  if (decoded.length !== Number(expected)) return invalid("DERIVED_PNG_SCANLINE_SIZE_INVALID");
  let position = 0;
  for (const pass of rows) for (let row = 0; row < pass.height; row++, position += pass.stride)
    if (decoded[position] > 4) return invalid("DERIVED_PNG_FILTER_INVALID");
  return { valid: true, profile: "png-chunk-crc-inflate-scanline-v1", width: header.width, height: header.height,
    decodedBytes: decoded.length, originalBytesPreserved: true, providerImageProcessingVerified: false };
}

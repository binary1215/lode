import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { copiedProjectFile } from "./project-copy-evidence.mjs";
import { captureHistoryChunks, historyHash, historyScopeCheck, HISTORY_IO_BYTES } from "./native-history-bytes.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const identity = s => ({ dev: String(s.dev), ino: String(s.ino) });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

// Explicit already-selected ancestor only. The decoded prefix is P3 evidence,
// not an original uncompressed file, whole-container verification or authority.
// No original is renamed, decompressed in place or replaced. Bytes beyond the
// requested decoded cutoff are neither stored nor parsed as conversation data.
export async function readCodexZstdPrefix({ root, relative, length, expectedIdentity = null, check = () => {}, onTemporaryCapture = () => {} }) {
  check = historyScopeCheck(check);
  check();
  if (!relative?.endsWith(".jsonl.zst") || !Number.isSafeInteger(length) || length < 1 || typeof zlib.createZstdDecompress !== "function") fail("CODEX_ZSTD_PREFIX_PROFILE_UNQUALIFIED");
  const file = copiedProjectFile(root, relative), before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER)
    || expectedIdentity && !same(identity(before), expectedIdentity)) fail("CODEX_ZSTD_SOURCE_IDENTITY_CHANGED");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let input = null, decoder = null, captured = null, prefixReached = false, compressedRead = 0, decodedBytes = 0, primary = null, decoderFailure = null;
  const inputDigest = crypto.createHash("sha256"), inputBound = Number(before.size);
  const verify = () => {
    check();
    for (const s of [fs.fstatSync(fd, { bigint: true }), fs.lstatSync(copiedProjectFile(root, relative), { bigint: true })])
      if (!s.isFile() || s.nlink !== 1n || !same(identity(s), identity(before)) || s.size !== before.size
        || s.mtimeNs !== before.mtimeNs || s.ctimeNs !== before.ctimeNs) fail("CODEX_ZSTD_SOURCE_CHANGED");
  };
  try {
    verify();
    const source = function* () {
      while (compressedRead < inputBound) {
        verify(); const bytes = Buffer.allocUnsafe(Math.min(65536, inputBound - compressedRead));
        const n = fs.readSync(fd, bytes, 0, bytes.length, compressedRead);
        if (!n) fail("CODEX_ZSTD_SOURCE_CHANGED");
        compressedRead += n; inputDigest.update(bytes.subarray(0, n)); yield bytes.subarray(0, n);
      }
    };
    input = Readable.from(source(), { objectMode: false, highWaterMark: 65536 });
    decoder = zlib.createZstdDecompress({ chunkSize: 65536, highWaterMark: 65536,
      params: { [zlib.constants.ZSTD_d_windowLogMax]: 26 } });
    decoder.on("error", error => { decoderFailure ??= error; });
    input.on("error", error => decoder.destroy(error)); input.pipe(decoder);
    const chunks = async function* () {
      for await (const bytes of decoder) {
        verify();
        const retained = Math.min(bytes.length, length - decodedBytes);
        if (retained > 0) { decodedBytes += retained; yield bytes.subarray(0, retained); }
        if (decodedBytes === length) { prefixReached = true; break; }
      }
      if (!prefixReached) fail("CODEX_ZSTD_PREFIX_TRUNCATED");
    };
    captured = await captureHistoryChunks(chunks(), check, storage => onTemporaryCapture({ ...storage, expectedBytes: length }));
    input.destroy(); decoder.destroy();
    for (const stream of [input, decoder]) try { await finished(stream); } catch (error) {
      if (!prefixReached || !["ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE"].includes(error.code)) throw error;
    }
    if (decoderFailure && !["ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE"].includes(decoderFailure.code)) throw decoderFailure;
    verify();
    // Reconcile exactly the compressed input actually observed. This never
    // reads/decompresses a parent suffix to claim a complete frame checksum.
    const digest = inputDigest.digest("hex"), reread = crypto.createHash("sha256"), bytes = Buffer.alloc(HISTORY_IO_BYTES);
    for (let offset = 0; offset < compressedRead;) {
      verify(); const n = fs.readSync(fd, bytes, 0, Math.min(bytes.length, compressedRead - offset), offset);
      if (!n) fail("CODEX_ZSTD_SOURCE_CHANGED"); reread.update(bytes.subarray(0, n)); offset += n;
    }
    if (reread.digest("hex") !== digest) fail("CODEX_ZSTD_SOURCE_CHANGED");
    verify(); const sha256 = historyHash(captured.raw);
    const result = { raw: captured.raw, sha256, relative, canonicalPath: fs.realpathSync(file), identity: identity(before), capture: captured,
      encoding: "zstd-decoded-selected-prefix", compressedRead, compressedSha256: digest,
      compressionEvidence: { kind: "CodexZstdDecodedPrefixObservation", authorityPlane: "P3", profile: "node-zstd-prefix-v1",
        node: process.version, zstd: process.versions.zstd ?? null, sourceIdentity: identity(before), sourceBytesObserved: inputBound,
        sourceRelativePath: relative, compressedInputStartByteOffset: 0, decodedPrefixStartByteOffset: 0,
        decoderInputBytesConsumed: decoder.bytesWritten,
        compressedInputBytesRead: compressedRead, compressedInputPrefixSha256: digest, decodedPrefixBytes: length, decodedPrefixSha256: sha256,
        decoderWindowLogMax: 26, inputChunkBytes: 65536, outputChunkBytes: 65536,
        originalEncoding: "zstd", storedEncoding: "decoded-selected-JSONL-prefix", compressedOriginalStored: false,
        compressedReadMayIncludeOpaqueFutureBytes: true, decodedFutureStored: false, decodedFutureInterpreted: false,
        fullContainerChecksumVerified: false, offlineCompressionReproductionClaimed: false,
        grantsRecoveryAuthority: false, restoresExecutionPermission: false } };
    verifyCodexZstdPrefixObservation(result.compressionEvidence, { bytes: length, sha256 });
    return result;
  } catch (error) { primary = error; if (captured) try { captured.release(); } catch (cleanup) { error.captureCleanup = { code: cleanup.code }; } throw error;
  } finally {
    input?.destroy(); decoder?.destroy();
    try { fs.closeSync(fd); } catch (cleanup) { if (primary) primary.descriptorCleanup = { code: cleanup.code }; else throw cleanup; }
  }
}

export function verifyCodexZstdPrefixObservation(evidence, { bytes, sha256 }) {
  const integer = n => Number.isSafeInteger(n) && n >= 0, digest = s => typeof s === "string" && /^[a-f0-9]{64}$/u.test(s);
  if (!integer(bytes) || bytes < 1 || !digest(sha256)
    || evidence?.kind !== "CodexZstdDecodedPrefixObservation" || evidence.authorityPlane !== "P3" || evidence.profile !== "node-zstd-prefix-v1"
    || typeof evidence.node !== "string" || !/^v\d+\.\d+\.\d+(?:[-+].*)?$/u.test(evidence.node) || evidence.zstd !== null && typeof evidence.zstd !== "string"
    || !/^\d+$/u.test(evidence.sourceIdentity?.dev ?? "") || !/^\d+$/u.test(evidence.sourceIdentity?.ino ?? "")
    || typeof evidence.sourceRelativePath !== "string" || !/^(?:sessions|archived_sessions)\/.+\.jsonl\.zst$/u.test(evidence.sourceRelativePath)
    || evidence.sourceRelativePath.split("/").some(part => ["", ".", ".."].includes(part)) || evidence.sourceRelativePath.includes("\\")
    || !integer(evidence.sourceBytesObserved) || !integer(evidence.compressedInputBytesRead) || evidence.compressedInputBytesRead < 1
    || evidence.compressedInputBytesRead > evidence.sourceBytesObserved || !integer(evidence.decoderInputBytesConsumed)
    || evidence.decoderInputBytesConsumed > evidence.compressedInputBytesRead || !digest(evidence.compressedInputPrefixSha256)
    || evidence.compressedInputStartByteOffset !== 0 || evidence.decodedPrefixStartByteOffset !== 0
    || evidence.decodedPrefixBytes !== bytes || evidence.decodedPrefixSha256 !== sha256
    || evidence.decoderWindowLogMax !== 26 || evidence.inputChunkBytes !== 65536 || evidence.outputChunkBytes !== 65536
    || evidence.originalEncoding !== "zstd" || evidence.storedEncoding !== "decoded-selected-JSONL-prefix"
    || evidence.compressedReadMayIncludeOpaqueFutureBytes !== true
    || ["compressedOriginalStored", "decodedFutureStored", "decodedFutureInterpreted", "fullContainerChecksumVerified", "offlineCompressionReproductionClaimed", "grantsRecoveryAuthority", "restoresExecutionPermission"].some(k => evidence[k] !== false))
    fail("CODEX_ZSTD_PREFIX_EVIDENCE_INVALID");
  return evidence;
}

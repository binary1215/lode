import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { copiedProjectFile, inspectCopiedProjectFile, readCopiedProjectExcerpt } from "./project-copy-evidence.mjs";
import { createSourceObservation, verifySourceObservation, sourceBundleKey, readSourceObservationOriginal } from "./source-observation.mjs";
import { validateDeclarationSelection } from "./python-source-collector.mjs";
import { DEFAULT_SCAN, MAX_REFERENCE_BYTES } from "./session-work-evidence-original.mjs";
import {
  validatePortableManifestFormat,
  selectedPortableSourceReferences,
  portableReferenceKey,
  portableFail,
  closedPortable,
  digestValid,
  PORTABLE_SOURCE_KINDS,
} from "./portable-project-format.mjs";

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const decode = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const closed = (value, fields) => {
  if (!closedPortable(value, fields)) portableFail("SOURCE_EXPORT_UNVERIFIED_FIELDS");
};
const identifier = (value) =>
  typeof value === "string" &&
  value.length <= 512 &&
  (value === "" || /^[\p{ID_Start}_][\p{ID_Continue}_]*(?:\.[\p{ID_Start}_][\p{ID_Continue}_]*)*$/u.test(value));
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// JSON.parse accepts duplicate names, discarding earlier values. A parsed
// allowlist cannot certify lossless raw transport. Native parsing establishes
// syntax; then a structural token scan checks every decoded object key. No
// recursion/depth gate, normalization, or interpretation of source text strings.
export function parsePortableSourceJson(bytes) {
  let text, parsed;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    portableFail("SOURCE_EXPORT_JSON_INVALID");
  }
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') break;
        i++;
      }
      const object = stack.at(-1);
      if (object?.keys && object.expectKey) {
        const key = JSON.parse(text.slice(start, i + 1));
        if (object.keys.has(key)) portableFail("SOURCE_EXPORT_DUPLICATE_JSON_KEY");
        object.keys.add(key);
        object.expectKey = false;
      }
    } else if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push({ keys: null });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && stack.at(-1)?.keys) stack.at(-1).expectKey = true;
  }
  return parsed;
}

export function verifyPortableSourceRawEligibility(root, projectId, raw, options = {}) {
  return verifyPortableSourceEligibility(root, projectId, parsePortableSourceJson(raw), options);
}
function range(value) {
  closed(value, ["start", "end"]);
  for (const point of [value.start, value.end]) {
    closed(point, ["line", "character"]);
    if (![point.line, point.character].every((n) => Number.isSafeInteger(n) && n >= 0)) portableFail("SOURCE_EXPORT_UNVERIFIED_FIELDS");
  }
}
function implementation(value) {
  closed(value, ["worker", "normalizer", "envelope", "observation"]);
  if (Object.keys(value).length !== 4 || !Object.values(value).every(digestValid)) portableFail("SOURCE_EXPORT_UNSUPPORTED_PROFILE");
}
function runtime(value) {
  closed(value, ["version", "python", "implementation", "astDigest", "tokenizeDigest", "isolated", "noSite"]);
  if (
    Object.keys(value).length !== 7 ||
    value.version !== "python-ast-direct-name-1" ||
    typeof value.python !== "string" ||
    value.python.length > 512 ||
    !/^\d+\.\d+\.\d+/.test(value.python) ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(value.implementation || "") ||
    !digestValid(value.astDigest) ||
    !digestValid(value.tokenizeDigest) ||
    value.isolated !== true ||
    value.noSite !== true
  )
    portableFail("SOURCE_EXPORT_UNSUPPORTED_PROFILE");
}

// Object checks only: raw transfer MUST use verifyPortableSourceRawEligibility.
// Additional transport/privacy eligibility, never a new ordinary-read gate.
// A digest proves identity, not absence of sensitive content or producer truth.
export function verifyPortableSourceEligibility(root, projectId, bundle, { storage, key = null } = {}) {
  verifySourceObservation(root, projectId, bundle, { storage, requireCurrent: false });
  closed(bundle, ["evidence", "descriptor", "observation"]);
  const e = bundle.evidence;
  closed(e, ["version", "projectId", "kind", "query", "sources", "profile", "observedAt", "response", "envelopeHash"]);
  if (Object.keys(e).length !== 9 || (key !== null && sourceBundleKey(e) !== key)) portableFail("SOURCE_EXPORT_IDENTITY_MISMATCH");
  const file = e.sources[0],
    query = e.query[0];
  closed(file, ["path", "digest", "base64"]);
  closed(query, e.version === 2 ? ["path", "symbol", "kind", "selection"] : ["path", "symbol"]);
  if (Object.keys(file).length !== 3 || !identifier(query.symbol) || !Number.isFinite(Date.parse(e.observedAt)))
    portableFail("SOURCE_EXPORT_UNVERIFIED_FIELDS");
  const bytes = Buffer.from(file.base64, "base64");
  if (bytes.toString("base64") !== file.base64 || bytes.length > MAX_REFERENCE_BYTES) portableFail("SOURCE_EXPORT_BYTE_BOUND");
  // Compare exact generated semantics too: normalize/validate functions need
  // not reject every nested extra in an otherwise digest-valid observation.
  const expected = createSourceObservation(e, storage);
  if (!equal(expected.descriptor, bundle.descriptor) || !equal(expected.observation, bundle.observation)) portableFail("SOURCE_EXPORT_UNVERIFIED_FIELDS");
  if (e.kind === "source") {
    if (Object.keys(e.profile).length) {
      closed(e.profile, ["reader", "implementation"]);
      if (e.profile.reader !== "exact-utf8-source-1") portableFail("SOURCE_EXPORT_UNSUPPORTED_PROFILE");
      implementation(e.profile.implementation);
    }
    if (e.response !== null || e.envelopeHash !== null) portableFail("SOURCE_EXPORT_UNVERIFIED_FIELDS");
  } else {
    closed(e.profile, ["runtime", "executableDigest", "implementation"]);
    if (!digestValid(e.profile.executableDigest)) portableFail("SOURCE_EXPORT_UNSUPPORTED_PROFILE");
    implementation(e.profile.implementation);
    runtime(e.profile.runtime);
    const raw = Buffer.from(e.response, "base64");
    if (raw.toString("base64") !== e.response) portableFail("SOURCE_EXPORT_UNVERIFIED_FIELDS");
    const response = parsePortableSourceJson(raw);
    closed(response, ["protocol", "profile", "results"]);
    runtime(response.profile);
    if (!equal(response.profile, e.profile.runtime)) portableFail("SOURCE_EXPORT_UNSUPPORTED_PROFILE");
    const result = response.results[0];
    if (e.kind === "outgoing-calls") {
      closed(result, ["path", "symbol", "pairs", "unresolved", "reason", "errorType", "availableSymbols"]);
      const reasons = [null, "no-supported-positive-direct-name-call", "symbol-missing-or-ambiguous", "parse-unsupported"];
      if (
        !reasons.includes(result.reason) ||
        (result.errorType !== undefined && !["SyntaxError", "ValueError", "RecursionError", "TokenError", "IndentationError"].includes(result.errorType))
      )
        portableFail("SOURCE_EXPORT_UNVERIFIED_FIELDS");
      if (result.availableSymbols !== undefined && (!Array.isArray(result.availableSymbols) || !result.availableSymbols.every(identifier)))
        portableFail("SOURCE_EXPORT_UNVERIFIED_FIELDS");
      for (const pair of result.pairs) {
        closed(pair, ["from", "to", "range"]);
        range(pair.range);
        for (const endpoint of [pair.from, pair.to]) {
          closed(endpoint, ["name", "symbolKind", "declarationRange", "selectionRange"]);
          if (!identifier(endpoint.name) || endpoint.symbolKind !== "function") portableFail("SOURCE_EXPORT_UNVERIFIED_FIELDS");
          range(endpoint.declarationRange);
          range(endpoint.selectionRange);
        }
      }
      for (const unresolved of result.unresolved) {
        closed(unresolved, ["range", "reason"]);
        range(unresolved.range);
        if (
          ![
            "dynamic-or-attribute-call",
            "ambiguous-or-decorated-local-definition",
            "enclosing-scope-not-resolved",
            "module-shadowing-import-or-rebinding",
            "external-ambiguous-or-decorated-definition",
            "local-shadowing-or-rebinding",
          ].includes(unresolved.reason)
        )
          portableFail("SOURCE_EXPORT_UNVERIFIED_FIELDS");
      }
    } else {
      // Existing declaration verifier closes result/selection/items and checks
      // every source/header/name range against these exact source bytes.
      if (query.selection) validateDeclarationSelection(query.selection);
      if (result.errorType !== undefined && !["SyntaxError", "ValueError", "RecursionError", "TokenError", "IndentationError"].includes(result.errorType))
        portableFail("SOURCE_EXPORT_UNVERIFIED_FIELDS");
      for (const declaration of result.declarations) {
        if (!identifier(declaration.qualifiedName) || !identifier(declaration.scope)) portableFail("SOURCE_EXPORT_UNVERIFIED_FIELDS");
      }
    }
  }
  return {
    sourceBytes: bytes.length,
    bundleKey: sourceBundleKey(e),
    observationId: bundle.observation.observationId,
    observationHash: bundle.observation.observationHash,
    evidenceKind: e.kind,
  };
}

export function readPortableJson(root, relative, maximum = MAX_REFERENCE_BYTES) {
  const stat = fs.lstatSync(copiedProjectFile(root, relative));
  if (stat.size > maximum) portableFail("SOURCE_EXPORT_BYTE_BOUND");
  const entry = inspectCopiedProjectFile(root, relative);
  if (entry.bytes > maximum) portableFail("SOURCE_EXPORT_BYTE_BOUND");
  const bytes = readCopiedProjectExcerpt(root, entry, { maxBytes: Math.max(1, entry.bytes) }).bytes;
  return { bytes, value: decode(bytes), entry };
}

// Existing admission/Session receipts are the originals. This per-request
// lookup is replaceable, has no database or authority-bearing hint file.
export function readPortableSourceHints(root, storage, project, owners = []) {
  const result = { bindings: new Map(), errors: [], inspectedEntries: 0, preflightBytes: 0, partial: false };
  const addManifest = (manifest) => {
    validatePortableManifestFormat(manifest);
    if (manifest.projectId !== project.projectId) portableFail("PROJECT_BUNDLE_IDENTITY_MISMATCH");
    if (manifest.schemaVersion === 1 || (owners.length && !owners.includes(manifest.selectedSessionId))) return;
    for (const ref of manifest.sourceTransfer.references)
      if (ref.status === "included-verified-retained-original") {
        const key = portableReferenceKey(ref.path, ref.digest);
        if (!result.bindings.has(key)) result.bindings.set(key, { ...ref, ownerSessionId: manifest.selectedSessionId });
      }
  };
  try {
    if (project.location?.kind === "portable-project-copy") {
      const receipt = readPortableJson(root, storage.directory + "/project-location/portable/" + project.location.admissionDigest + ".json");
      if (sha(receipt.bytes) !== project.location.admissionDigest || receipt.value.projectId !== project.projectId)
        portableFail("PROJECT_PORTABLE_ADMISSION_INVALID");
      const manifest = readPortableJson(root, storage.directory + "/project-location/portable-bundles/" + receipt.value.bundleManifestDigest + ".json");
      if (sha(manifest.bytes) !== receipt.value.bundleManifestDigest || !equal(manifest.value.files, receipt.value.inventory.files))
        portableFail("PROJECT_PORTABLE_ADMISSION_INVALID");
      addManifest(manifest.value);
    }
  } catch (error) {
    result.errors.push(error.code || "SOURCE_TRANSFER_PROOF_INVALID");
  }
  for (const owner of [...new Set(owners)]) {
    if (!/^session-[a-fA-F0-9-]{36}$/.test(owner)) continue;
    for (const base of [storage.directory + "/sessions", storage.directory + "/sessions/by-id/" + owner]) {
      if (base === storage.directory + "/sessions") {
        try {
          if (readPortableJson(root, base + "/current.json").value.sessionId !== owner) continue;
        } catch (error) {
          if (error.code === "ENOENT") continue;
          result.partial = true;
          continue;
        }
      }
      const directory = base + "/imports";
      let listing;
      try {
        listing = fs.opendirSync(copiedProjectFile(root, directory));
      } catch (error) {
        if (error.code !== "ENOENT") result.errors.push(error.code);
        continue;
      }
      try {
        let entry;
        while ((entry = listing.readSync())) {
          if (++result.inspectedEntries > DEFAULT_SCAN) {
            result.partial = true;
            break;
          }
          if (!/^project-bundle-[a-f0-9]{24}$/.test(entry.name)) continue;
          try {
            const archive = directory + "/" + entry.name;
            const receipt = readPortableJson(root, archive + "/receipt.json");
            const { receiptId, receiptDigest, ...payload } = receipt.value;
            if (receipt.value.sessionId !== owner) continue;
            if (
              receipt.value.kind !== "SelectedSessionImportReceipt" ||
              receipt.value.projectId !== project.projectId ||
              receipt.value.bundleId !== entry.name ||
              sha(json(payload)) !== receiptDigest ||
              receiptId !== "session-import-" + receiptDigest.slice(0, 24)
            )
              portableFail("PROJECT_IMPORTED_ORIGINAL_RECEIPT_INVALID");
            const original = readPortableJson(root, archive + "/bundle-manifest.json");
            result.preflightBytes += original.bytes.length + receipt.bytes.length;
            if (result.preflightBytes > MAX_REFERENCE_BYTES) {
              result.partial = true;
              break;
            }
            if (sha(original.bytes) !== receipt.value.manifestSha256 || entry.name !== "project-bundle-" + receipt.value.manifestSha256.slice(0, 24))
              portableFail("PROJECT_IMPORTED_ORIGINAL_RECEIPT_INVALID");
            validatePortableManifestFormat(original.value);
            for (const ref of original.value.sourceTransfer?.references || [])
              if (ref.status === "included-verified-retained-original") {
                const sourcePath = storage.directory + "/observations/source-bundles/" + ref.bundleKey + ".json";
                if (
                  !receipt.value.activeOriginals.some(
                    (mapping) =>
                      mapping.sourcePath === sourcePath &&
                      mapping.storedPath === sourcePath &&
                      mapping.sha256 === ref.rawSha256 &&
                      mapping.bytes === ref.rawBundleBytes,
                  )
                )
                  portableFail("PROJECT_IMPORTED_ORIGINAL_RECEIPT_INVALID");
              }
            addManifest(original.value);
          } catch (error) {
            result.errors.push(error.code || "SOURCE_TRANSFER_PROOF_INVALID");
          }
        }
      } finally {
        listing.closeSync();
      }
    }
  }
  return result;
}

export function collectPortableSourceOriginals({ root, storage, project, sessionId, records, mode, signal }) {
  const references = selectedPortableSourceReferences(records).map((ref) => ({
    ...ref,
    status: mode === "refs-only" ? "not-requested-body-transfer" : "retained-original-unavailable",
    reasonCode: mode === "refs-only" ? "SOURCE_BODY_TRANSFER_NOT_REQUESTED" : "RETAINED_SOURCE_NOT_FOUND_IN_BOUNDED_LOOKUP",
    sourceBytes: null,
    rawBundleBytes: null,
    proof: "not-certified",
  }));
  const files = new Map(),
    targets = new Map(references.map((ref) => [portableReferenceKey(ref.path, ref.digest), ref]));
  const coverage = { inspectedEntries: 0, preflightBytes: 0, partial: false, reasonCode: null };
  const transfer = {
    schemaVersion: 1,
    mode,
    gitLookup: "not-looked-up-not-included",
    supportedKinds: PORTABLE_SOURCE_KINDS,
    references,
    lookupCoverage: coverage,
  };
  if (mode === "refs-only" || !references.length) return { transfer, files: [] };
  const hinted = readPortableSourceHints(root, storage, project, [sessionId]);
  if (hinted.errors.length) {
    coverage.partial = true;
    coverage.reasonCode = hinted.errors[0];
    for (const ref of references) ref.reasonCode = hinted.errors[0];
    return { transfer, files: [] };
  }
  const exactHintedReferences = new Set(hinted.bindings.keys());
  let deniedLookup = false;
  const directory = storage.directory + "/observations/source-bundles";
  const inspect = (key, exact = null) => {
    if (signal?.aborted) portableFail("PROJECT_PORTABILITY_CANCELLED");
    const relative = directory + "/" + key + ".json";
    let target = exact;
    try {
      const stat = fs.lstatSync(copiedProjectFile(root, relative));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) portableFail("PROJECT_COPY_UNSAFE_FILE");
      if (stat.size > MAX_REFERENCE_BYTES || (!exact && coverage.preflightBytes + stat.size > MAX_REFERENCE_BYTES)) {
        coverage.partial = true;
        coverage.reasonCode = "RETAINED_SOURCE_BUNDLE_BYTE_BUDGET_REACHED";
        return;
      }
      coverage.preflightBytes += stat.size;
      const { bundle, original } = readSourceObservationOriginal(root, project.projectId, key, { storage, requireCurrent: false });
      const source = bundle.evidence.sources[0];
      target ||= targets.get(portableReferenceKey(source.path, source.digest));
      if (
        !target ||
        target.status === "included-verified-retained-original" ||
        (!exact && exactHintedReferences.has(portableReferenceKey(target.path, target.digest)))
      )
        return;
      if (source.path !== target.path || source.digest !== target.digest || (exact?.rawSha256 && original.sha256 !== exact.rawSha256))
        portableFail("SOURCE_EXPORT_IDENTITY_MISMATCH");
      target.rawBundleBytes = original.byteLength;
      target.sourceBytes = Buffer.from(source.base64, "base64").length;
      const strictRaw = readPortableJson(root, relative).bytes;
      if (strictRaw.length !== original.byteLength || sha(strictRaw) !== original.sha256) portableFail("SOURCE_DRIFT");
      const eligible = verifyPortableSourceRawEligibility(root, project.projectId, strictRaw, { storage, key });
      Object.assign(target, eligible, {
        status: "included-verified-retained-original",
        reasonCode: null,
        rawSha256: original.sha256,
        proof: "raw-and-semantic-identities-verified-no-producer-truth-claim",
      });
      files.set(relative, { path: relative, bytes: original.byteLength, sha256: original.sha256 });
    } catch (error) {
      if (error.code === "PROJECT_PORTABILITY_CANCELLED") throw error;
      if (["EACCES", "EPERM"].includes(error.code)) {
        deniedLookup = true;
        coverage.reasonCode = error.code;
      }
      if (target) {
        target.reasonCode = error.code || "RETAINED_SOURCE_INVALID";
        target.status = error.code?.startsWith("SOURCE_EXPORT_") ? "excluded-export-eligibility" : "retained-original-unavailable";
      } else {
        coverage.partial = true;
        coverage.reasonCode ||= error.code || "RETAINED_SOURCE_INVALID";
      }
    }
  };
  for (const [key, hint] of hinted.bindings) {
    const target = targets.get(key);
    if (target) inspect(hint.bundleKey, Object.assign(target, { rawSha256: hint.rawSha256 }));
  }
  let listing;
  try {
    listing = fs.opendirSync(copiedProjectFile(root, directory));
    let entry;
    while (!deniedLookup && references.some((ref) => ref.status !== "included-verified-retained-original") && (entry = listing.readSync())) {
      if (++coverage.inspectedEntries > DEFAULT_SCAN) {
        coverage.partial = true;
        coverage.reasonCode ||= "RETAINED_SOURCE_BUNDLE_INVENTORY_PARTIAL";
        break;
      }
      if (/^[a-f0-9]{64}\.json$/.test(entry.name)) inspect(entry.name.slice(0, -5));
      if (coverage.preflightBytes >= MAX_REFERENCE_BYTES) break;
    }
  } catch (error) {
    if (error.code === "PROJECT_PORTABILITY_CANCELLED") throw error;
    coverage.reasonCode ||= error.code || "RETAINED_SOURCE_UNAVAILABLE";
  } finally {
    listing?.closeSync();
  }
  for (const ref of references)
    if (ref.status !== "included-verified-retained-original") {
      delete ref.rawSha256;
      if (coverage.reasonCode && ref.reasonCode === "RETAINED_SOURCE_NOT_FOUND_IN_BOUNDED_LOOKUP") ref.reasonCode = coverage.reasonCode;
    }
  return { transfer, files: [...files.values()] };
}

export function verifyPortableSourceObjects({ root, manifest, readOriginal }) {
  validatePortableManifestFormat(manifest);
  const allowed = [];
  for (const ref of manifest.sourceTransfer?.references || [])
    if (ref.status === "included-verified-retained-original") {
      const relative = manifest.directory + "/observations/source-bundles/" + ref.bundleKey + ".json";
      if (ref.rawBundleBytes > MAX_REFERENCE_BYTES) portableFail("SOURCE_EXPORT_BYTE_BOUND");
      const raw = readOriginal(relative);
      if (raw.length !== ref.rawBundleBytes || sha(raw) !== ref.rawSha256) portableFail("PROJECT_COPY_SOURCE_CHANGED");
      const bundle = decode(raw),
        storage = { directory: manifest.directory, dialect: manifest.directory === ".lode" ? "lode" : "head" };
      const eligible = verifyPortableSourceRawEligibility(root, manifest.projectId, raw, { storage, key: ref.bundleKey });
      if (
        bundle.evidence.sources[0].path !== ref.path ||
        bundle.evidence.sources[0].digest !== ref.digest ||
        !Object.entries(eligible).every(([key, value]) => ref[key] === value)
      )
        portableFail("PROJECT_BUNDLE_SOURCE_REFERENCE_MISMATCH");
      allowed.push(relative);
    }
  return allowed;
}

import { verifyWorkerPatchCandidate } from "./worker-patch-basis.mjs";

const key = value => process.platform === "win32" ? value.toLowerCase() : value;
const same = (a, b) => a.kind === b.kind && (a.kind === "absent"
  || a.mode === b.mode && a.digest === b.digest && a.bytes === b.bytes);
const fail = message => { throw Object.assign(new Error(message), { code: "WORKER_PATCH_COMPOSITION_INVALID" }); };

// Pure P4 preparation over already collected candidates. Array positions retain
// provenance even when two workers returned byte-identical candidates. The
// caller must independently bind each position to its verified authorization,
// receipt and current lineage before persisting intent or applying any effect.
// This function neither reads Canon nor interprets semantic compatibility.
export function composeWorkerPatchCandidates({ candidates, maxBytes }) {
  if (!Array.isArray(candidates) || !candidates.length
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0) fail("Composition requires candidates and an explicit finite byte bound.");
  for (const candidate of candidates) verifyWorkerPatchCandidate(candidate);
  const claims = new Map();
  const conflicts = [];
  const basisDiagnostics = [];
  for (let memberIndex = 0; memberIndex < candidates.length; memberIndex++) {
    const candidate = candidates[memberIndex];
    for (const before of candidate.basis) {
      const patch = candidate.patches.find(item => item.before.path === before.path);
      const identity = key(before.path);
      const claim = claims.get(identity) || { path: before.path, claims: [] };
      claim.claims.push({ memberIndex, before, after: patch?.after || null });
      claims.set(identity, claim);
    }
  }
  const ordered = [...claims.values()].sort((a, b) => a.path < b.path ? -1 : 1);
  const patches = [];
  let bytes = 0;
  for (const claim of ordered) {
    const effects = claim.claims.filter(item => item.after !== null);
    if (claim.claims.some(item => !same(item.before, claim.claims[0].before) || item.before.path !== claim.path)) {
      basisDiagnostics.push({ path: claim.path, reason: "different-basis-observations",
        memberIndices: claim.claims.map(item => item.memberIndex) });
    }
    // No-op ownership is an observation, not a reservation or an invariant.
    // Semantic read dependencies remain HEAD's separate integration assessment.
    if (!effects.length) continue;
    const identities = effects.map(item => item.memberIndex);
    const effectPath = effects[0].before.path;
    if (effects.some(item => item.before.path !== effectPath)) {
      conflicts.push({ path: effectPath, reason: "path-alias", memberIndices: identities });
      continue;
    }
    if (effects.some(item => !same(item.before, effects[0].before))) {
      conflicts.push({ path: effectPath, reason: "different-preimages", memberIndices: identities });
      continue;
    }
    if (effects.some(item => !same(item.after, effects[0].after))) {
      conflicts.push({ path: claim.path, reason: "different-postimages", memberIndices: effects.map(item => item.memberIndex) });
      continue;
    }
    const { before, after } = effects[0];
    bytes += (before.bytes || 0) + (after.bytes || 0);
    patches.push({ before: structuredClone(before), after: structuredClone(after),
      memberIndices: effects.map(item => item.memberIndex) });
  }
  // Only actual effects reserve paths. An unchanged absent ancestor does not
  // prohibit another candidate creating a file below that directory.
  for (const claim of ordered) {
    const effects = claim.claims.filter(item => item.after !== null);
    if (!effects.length) continue;
    const parts = claim.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = claims.get(key(parts.slice(0, i).join("/")));
      const parentEffects = parent?.claims.filter(item => item.after !== null) || [];
      if (parentEffects.length) conflicts.push({ path: claim.path, parentPath: parent.path,
        reason: "ancestor-overlap", memberIndices: [...new Set([...parentEffects, ...effects].map(item => item.memberIndex))].sort((a, b) => a - b) });
    }
  }
  if (!Number.isSafeInteger(bytes) || bytes > maxBytes) fail("Combined preimage and postimage bytes exceed the requested byte budget (not serialized transport size).");
  return { candidateHashes: candidates.map(candidate => candidate.candidateHash), patches, conflicts, basisDiagnostics,
    status: conflicts.length ? "conflict" : "compatible-file-effects", bytes,
    // Compatible bytes are not semantic compatibility, authorization, an apply
    // transaction, or even proof that current canonical preimages still match.
    applied: false, currentBasisVerified: false, lineageVerified: false,
    semanticVerification: "not-assessed", instructionAuthority: false,
    promotionAuthority: false, recoveryAuthority: false };
}

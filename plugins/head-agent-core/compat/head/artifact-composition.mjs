// Exact pre-rename descriptors from the accepted beta.45 source/carrier.
// Call only after manifest identity and every listed byte have been verified.
// This is historical reading, not a producer option or Host namespace alias.
export function historicalArtifactServerName(identity, verifiedDescriptorSha256) {
  // Pre-Lode HEAD snapshots already permitted an absent descriptor.
  if (identity === "head" && verifiedDescriptorSha256 === undefined) return "head_core";
  if (identity === "lode" && verifiedDescriptorSha256 === "9c6c44ce360d5bba284ceb3baa5ceda8d989dc7de6e2dff37ce8cac6db72d539") return "lode_core";
  if (identity === "head" && verifiedDescriptorSha256 === "74d32f16511ce300663049f190fe5a65176ebcbb602cab20b45978b097ee44c9") return "head_core";
  return null;
}

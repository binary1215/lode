// Shared pure SemVer ordering, independent of publication or storage effects.
export function versionParts(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || (match[4] || "").split(".").some((part) => /^0\d+$/.test(part)))
    (() => {
      throw new Error("PUBLICATION_VERSION_CONFLICT: Invalid semantic version.");
    })();
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") || [] };
}
export function comparePublicationVersions(left, right) {
  const a = versionParts(left),
    b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === b.pre[i]) continue;
    if (a.pre[i] === undefined || b.pre[i] === undefined) return a.pre[i] === undefined ? -1 : 1;
    const an = /^\d+$/.test(a.pre[i]),
      bn = /^\d+$/.test(b.pre[i]);
    if (an !== bn) return an ? -1 : 1;
    return an ? (BigInt(a.pre[i]) > BigInt(b.pre[i]) ? 1 : -1) : a.pre[i] > b.pre[i] ? 1 : -1;
  }
  return 0;
}

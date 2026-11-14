// The two canonical-JSON normalizers used across scripts/lib. They are kept as
// separate functions and are not merged: each module keeps the one it used.

// Session-recovery family: object keys sorted with the default Array sort.
export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export const canonicalJson = (value) => JSON.stringify(canonicalValue(value));

// Runtime-adapter family: object keys sorted with an explicit code-unit comparator.
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export function runtimeCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(runtimeCanonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, runtimeCanonicalValue(value[key])]),
    );
  }
  return value;
}

export const runtimeCanonicalJson = (value) => JSON.stringify(runtimeCanonicalValue(value));

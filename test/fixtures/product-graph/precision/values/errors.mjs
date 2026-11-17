// Synthetic error factory for the call-precision tests. Not a real product.
export function failWith(code) {
  return (message) => {
    throw new Error(`${code}: ${message}`);
  };
}

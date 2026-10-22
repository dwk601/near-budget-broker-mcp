// Strict compressed Edwards25519 public-point validation. Node/OpenSSL remains
// the signature verifier, but accepts some small-order keys. Validate the public
// config point before constructing a KeyObject; never use this arithmetic for
// signing or secret material. No undeclared/transitive crypto dependency.
const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const SQRT_MINUS_ONE = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;
const mod = (n: bigint): bigint => ((n % P) + P) % P;
function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  for (; exponent > 0n; exponent >>= 1n) {
    if (exponent & 1n) result = mod(result * base);
    base = mod(base * base);
  }
  return result;
}

export function assertOwnerPoint(bytes: Uint8Array): void {
  if (bytes.length !== 32) throw new Error('Invalid owner point');
  const encoded = BigInt(`0x${Buffer.from(bytes).reverse().toString('hex')}`);
  const sign = encoded >> 255n;
  const y = encoded & ((1n << 255n) - 1n);
  // RFC8032 decoding: y must be canonical, x must exist, and zero x may not
  // carry a negative sign. OpenSSL key construction alone does not check these.
  if (y >= P) throw new Error('Invalid owner point');
  const ySquared = mod(y * y);
  const denominator = mod(D * ySquared + 1n);
  if (denominator === 0n) throw new Error('Invalid owner point');
  const xSquared = mod((ySquared - 1n) * pow(denominator, P - 2n));
  let x = pow(xSquared, (P + 3n) / 8n);
  if (mod(x * x) !== xSquared) x = mod(x * SQRT_MINUS_ONE);
  if (mod(x * x) !== xSquared || (x === 0n && sign === 1n)) throw new Error('Invalid owner point');
  if ((x & 1n) !== sign) x = mod(-x);

  // Three projective Edwards doublings compute [8]P without inversions.
  // Reject every member of the small-order subgroup, not only the identity.
  let X = x; let Y = y; let Z = 1n;
  for (let i = 0; i < 3; i++) {
    const a = mod(X * X); const b = mod(Y * Y); const c = mod(2n * Z * Z);
    const d = mod(-a); const e = mod((X + Y) ** 2n - a - b);
    const g = mod(d + b); const f = mod(g - c); const h = mod(d - b);
    X = mod(e * f); Y = mod(g * h); Z = mod(f * g);
  }
  if (Z === 0n || (X === 0n && Y === Z)) throw new Error('Invalid owner point');
}

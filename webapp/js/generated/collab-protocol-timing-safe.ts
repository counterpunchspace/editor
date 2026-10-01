/** GENERATED from collab/packages/protocol. Do not edit by hand. */
// @ts-nocheck

const encoder = new TextEncoder();

/** Constant-time (length-independent leak only) string equality. */
export function timingSafeEqualString(left, right) {
  const a = encoder.encode(String(left ?? ""));
  const b = encoder.encode(String(right ?? ""));
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    different |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return different === 0;
}
